// What a trail has been through, derived from its events. Pure: the inbox's detail pane, `ephyra show`, the
// Textbook stories and the landing page's walkthrough all read this one function.
// It never infers a result the events don't record: a proof shows as passed only when a proof bundle for the
// trail's current revision says so, and a missing artefact stays missing.
import type {
	Decision,
	LandingReceipt,
	ProofBundle,
	Trail,
	TrailEvent,
	TriageResult,
	WatchConfig,
} from "@ephyra/core";

/** The trail's stages, in order. A checkpoint gates the end of hypothesis (A), plan (B) and proof (C). */
export const STAGES = [
	"signal",
	"evidence",
	"hypothesis",
	"repro",
	"plan",
	"patch",
	"proof",
	"land",
	"watch",
] as const;
export type Stage = (typeof STAGES)[number];
export const GATE_AT: Record<"A" | "B" | "C", number> = { A: 2, B: 4, C: 6 };

/** Where each live state sits on the stages. Halted states are placed by how far their events got. */
const AT: Partial<Record<Trail["state"], number>> = {
	sensed: 0,
	triaged: 1,
	researching: 1,
	hypothesised: 2,
	reproducing: 3,
	planned: 4,
	patching: 5,
	proving: 6,
	ready: 6,
	landing: 7,
	watching: 8,
	rolled_back: 8,
	closed: STAGES.length,
};
/** How far an event proves the trail got (the stage it completed). */
const REACHED: Partial<Record<TrailEvent["type"], number>> = {
	trail_created: 0,
	triage_completed: 1,
	research_completed: 2,
	plan_completed: 4,
	patch_completed: 5,
	proof_completed: 6,
	landing_completed: 7,
	watch_started: 8,
};

/** How an activity line reads: plain, went well, needs a look, went wrong, or a person did it. */
export type Mood = "plain" | "ok" | "warn" | "bad" | "human";
export type Activity = { at: string; who: string; text: string; tone: Mood };

export type TrailStory = {
	/** Index into STAGES of where the trail is now; STAGES.length once closed. */
	stage: number;
	/** Waiting on a human at this checkpoint. */
	gate?: "A" | "B" | "C";
	halted?: "parked" | "handed_off" | "abandoned" | "rolled_back";
	triage?: TriageResult;
	repro?: { ok: boolean; probe?: string; reason?: string };
	/** The latest proof bundle for the trail's current revision, and nothing older. */
	proof?: { bundle: ProofBundle; digest: string };
	landings: LandingReceipt[];
	watch?: WatchConfig;
	watchClean?: boolean;
	regressed?: { criterion: string; evidence: string };
	rollback?: LandingReceipt;
	decisions: Partial<Record<"A" | "B" | "C", Decision>>;
	comments: Activity[];
	activity: Activity[];
	occurrences: number;
	spend?: { purpose: string; microusd: number };
	/** Revision the trail is on; a rollback reopens it at the next one. */
	rev: number;
	/** A landing was undone and the trail started over at a new revision. */
	reopened?: boolean;
};

export const usd = (microusd: number) => `$${(microusd / 1e6).toFixed(2)}`;
export const duration = (s: number) =>
	s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`;
export const MODE: Record<LandingReceipt["mode"], string> = {
	devenv_live: "live in devenv",
	trail_ref: "quest ref",
	radicle_patch: "Radicle patch",
	tangled_pull: "Tangled pull",
	auto_land: "auto-land",
};
const VERB = {
	approve: "approved",
	revise: "sent back",
	reject: "rejected",
} as const;
const who = (e: TrailEvent) => {
	// A DID is long and mostly prefix; its tail is what tells two people apart.
	if (e.actor.kind === "human")
		return e.actor.id.startsWith("did:")
			? `did…${e.actor.id.slice(-6)}`
			: e.actor.id;
	return e.actor.kind === "agent"
		? "agent"
		: e.actor.kind === "policy"
			? "policy"
			: "ephyra";
};

/** One line describing an event, for the activity log. */
export function describe(e: TrailEvent): { text: string; tone: Mood } {
	switch (e.type) {
		case "trail_created":
			return { text: `signal: ${e.data.title}`, tone: "plain" };
		case "new_signal":
			return { text: "the same failure, seen again", tone: "plain" };
		case "triage_completed": {
			const r = e.data.result;
			return {
				text: `triaged: ${r.route.replace("_", " ")}, sev ${r.severity}, risk ${r.risk}`,
				tone: "plain",
			};
		}
		case "research_completed":
			return { text: `wrote ${e.data.hypothesis}`, tone: "plain" };
		case "checkpoint_decided": {
			const d = e.data.decision;
			const tail = `${d.shadow ? " (shadow)" : ""}${d.note ? `: ${d.note}` : ""}`;
			return {
				text: `${e.data.checkpoint} ${VERB[d.verdict]}${tail}`,
				tone: d.verdict === "approve" ? "ok" : "warn",
			};
		}
		case "repro_completed":
			return e.data.ok
				? {
						text: `reproduced: ${e.data.probe ?? "probe"} fails on base`,
						tone: "ok",
					}
				: {
						text: `not reproduced: ${e.data.reason ?? "no failing probe"}`,
						tone: "warn",
					};
		case "plan_completed":
			return { text: `wrote ${e.data.plan}`, tone: "plain" };
		case "patch_completed":
			return {
				text: `patch rev ${e.data.revision} at ${e.data.head.slice(0, 7)}`,
				tone: "plain",
			};
		case "proof_completed":
			return e.data.bundle.passed
				? { text: `proof passed, rev ${e.data.bundle.rev}`, tone: "ok" }
				: {
						text: `proof failed: missing ${e.data.bundle.missing.join(", ") || "required items"}`,
						tone: "bad",
					};
		case "land_requested":
			return { text: "landing requested", tone: "plain" };
		case "landing_completed": {
			const r = e.data.receipt;
			return {
				text: `landed: ${MODE[r.mode]} → ${r.target} ${r.newOid.slice(0, 7)}`,
				tone: "ok",
			};
		}
		case "landing_failed":
			return { text: `landing failed: ${e.data.reason}`, tone: "bad" };
		case "base_moved":
			return {
				text: `base moved to ${e.data.newSha.slice(0, 7)}`,
				tone: "warn",
			};
		case "watch_started":
			return {
				text: `watching for ${duration(e.data.config.windowS)}`,
				tone: "plain",
			};
		case "watch_completed":
			return { text: "watch window clean", tone: "ok" };
		case "probe_regressed_after_landing":
			return { text: `regressed: ${e.data.criterion}`, tone: "bad" };
		case "rollback_completed":
			return {
				text: `rolled back: ${MODE[e.data.receipt.mode]} → ${e.data.receipt.target} ${e.data.receipt.newOid.slice(0, 7)}`,
				tone: "bad",
			};
		case "human_comment":
			return { text: e.data.text, tone: "human" };
		case "claimed_by_human":
			return { text: "took over", tone: "human" };
		case "human_revision":
			return { text: `pushed ${e.data.head.slice(0, 7)}`, tone: "human" };
		case "released_by_human":
			return { text: "handed back to the agent", tone: "human" };
		case "parked":
			return { text: `parked: ${e.data.reason}`, tone: "warn" };
		case "resumed":
			return { text: "resumed", tone: "plain" };
		case "killed":
			return { text: `killed: ${e.data.reason}`, tone: "bad" };
		case "budget_exceeded":
			return { text: `over budget: ${e.data.summary}`, tone: "warn" };
		case "spend_requested":
			return {
				text: `asks to spend ${usd(e.data.microusd)}: ${e.data.purpose}`,
				tone: "warn",
			};
		case "spend_decided":
			return {
				text: `spend ${VERB[e.data.decision.verdict]}`,
				tone: e.data.decision.verdict === "approve" ? "ok" : "warn",
			};
		case "child_trail_finished":
			return { text: "a child quest finished", tone: "plain" };
		case "parent_trail_landed":
			return { text: "the parent quest landed", tone: "plain" };
		case "intent_updated":
			return { text: `intent updated: ${e.data.intent}`, tone: "plain" };
		case "mirror_linked":
			return { text: `linked ${e.data.kind}`, tone: "plain" };
		case "agent_failed":
			return {
				text: `agent ${e.data.step} failed: ${e.data.reason}`,
				tone: "bad",
			};
	}
	return { text: (e as TrailEvent).type, tone: "plain" };
}

export function trailStory(trail: Trail, events: TrailEvent[]): TrailStory {
	const story: TrailStory = {
		stage: 0,
		landings: [],
		decisions: {},
		comments: [],
		activity: [],
		occurrences: trail.signals.length,
		rev: trail.rev,
	};
	let reached = 0;
	for (const e of events) {
		const r = REACHED[e.type];
		if (r !== undefined && r > reached) reached = r;
		const line = { at: e.at, who: who(e), ...describe(e) };
		story.activity.push(line);
		switch (e.type) {
			case "triage_completed":
				story.triage = e.data.result;
				break;
			case "repro_completed":
				story.repro = e.data;
				if (e.data.ok && reached < 3) reached = 3;
				break;
			case "proof_completed":
				if (e.data.bundle.rev === trail.rev)
					story.proof = { bundle: e.data.bundle, digest: e.data.digest };
				break;
			case "landing_completed":
				story.landings.push(e.data.receipt);
				break;
			case "watch_started":
				story.watch = e.data.config;
				story.watchClean = undefined;
				break;
			case "watch_completed":
				story.watchClean = true;
				break;
			case "probe_regressed_after_landing":
				story.regressed = e.data;
				break;
			case "rollback_completed":
				story.rollback = e.data.receipt;
				break;
			case "checkpoint_decided":
				story.decisions[e.data.checkpoint] = e.data.decision;
				break;
			case "human_comment":
				story.comments.push(line);
				break;
			case "spend_requested":
				story.spend = { purpose: e.data.purpose, microusd: e.data.microusd };
				break;
			case "spend_decided":
				story.spend = undefined;
				break;
		}
	}
	if (trail.pendingSpend) story.spend = trail.pendingSpend;
	const at = AT[trail.state];
	if (at !== undefined) story.stage = at;
	else {
		story.halted = trail.state as TrailStory["halted"];
		const resume = trail.resumeTo ? AT[trail.resumeTo] : undefined;
		story.stage = Math.min(resume ?? reached, STAGES.length - 1);
	}
	if (trail.state === "rolled_back") story.halted = "rolled_back";
	const undone = events.findLast((e) => e.type === "rollback_completed");
	if (undone && trail.rev > undone.rev && trail.state !== "rolled_back")
		story.reopened = true;
	if (trail.state === "hypothesised") story.gate = "A";
	if (trail.state === "planned") story.gate = "B";
	if (trail.state === "ready") story.gate = "C";
	return story;
}
