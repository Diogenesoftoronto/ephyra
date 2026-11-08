// An example trail, for the Textbook stories, the snapshot tests and the landing page's walkthrough.
// It is sample data and says so wherever it's shown. It is never read by the server and is not evidence of
// anything: the proof below describes a run that is part of the example, not one that happened.
// Every object here parses with the core schemas (see test/demo.test.ts), so the views are exercised with real shapes.
import type { InboxItem, ProofBundle, Trail, TrailEvent } from "@ephyra/core";

const REPO = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const ID = "0193f2b6-7d4a-7c1e-9b2f-5e6a8c4c1e0f";
const SIGNAL = "0193f2b6-6f10-7a2b-8c3d-4e5f60718293";
const BASE = "8c1e0f2a9d4b7e6c5a3f1d0e9b8c7a6f5e4d3c2b";
const HEAD = "4f2a9c1e7b3d5f6a8c0e2b4d6f8a1c3e5b7d9f0a";
const LANDED = "a71c3e5b9d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8c";
const FP = "fp:checkout/total.ts:42:TotalMismatch";
const PRINCIPAL = "did:plc:45dp424mncijxohc4ba2eiyz";

export const DEMO_TEXT = {
	hypothesis: `# Hypothesis
\`sumLineItems\` rounds each line to whole cents before adding them up, so a cart of discounted lines can total a cent less than the amount charged.

## Evidence
- 37 failures since 14:02, every one a cart with three or more discounted lines
- Started with 8c1e0f2, "show per-line discounts"
- No earlier quest touched total.ts

## Next
Reproduce with three lines at 33⅓% off, then round once, at the end.`,
	plan: `# Plan
1. Keep line totals in integer micro-cents; round once, in \`cartTotal\`.
2. Add the probe \`checkout/one-cent-drift\`; it fails on base.
3. Leave the receipt's display rounding alone.

Touches: services/checkout/src/total.ts, total.test.ts
Not touching: the payments adapter.`,
	evidence: JSON.stringify([
		{
			source: "otel",
			title: "TotalMismatch in sumLineItems",
			snippet: "charged 4199 ≠ cart 4198 · 37 events · POST /checkout",
			score: 0.97,
		},
		{
			source: "git",
			title: "8c1e0f2 show per-line discounts",
			snippet: "total.ts: round each line before summing",
			score: 0.91,
		},
		{
			source: "trails",
			title: "No earlier quest touched total.ts",
			snippet: "0 open, 0 closed in this area since March",
			score: 0.6,
		},
		{
			source: "entire",
			title: "Session that wrote 8c1e0f2",
			snippet: "agent asked for per-line display; rounding moved with it",
			score: 0.55,
		},
	]),
	autonomy: `# Autonomy policy

## defaults
mode: shadow
checkpoints: A=advisory B=advisory C=blocking
landing: trail_ref
watch: 2h

## area: checkout
paths: services/checkout/**
risk: medium
checkpoints: A=blocking B=blocking C=blocking
landing: radicle_patch
watch: 2h

Money moves here. A person reads the
hypothesis and the plan before any code.

## area: docs
paths: docs/**, **/*.md
risk: low
checkpoints: A=advisory B=advisory C=advisory
landing: auto_land
watch: 1h`,
};

const t = (hhmm: string) => `2026-11-07T${hhmm}:00.000-05:00`;
let n = 0;
const ev = (
	at: string,
	actor: TrailEvent["actor"],
	body: Omit<TrailEvent, "schema" | "id" | "trail" | "rev" | "at" | "actor">,
	rev = 1,
): TrailEvent => {
	n++;
	return {
		schema: 1,
		id: `0193f2b6-${(0x8000 + n).toString(16)}-7000-8000-${n.toString(16).padStart(12, "0")}`,
		trail: ID,
		rev,
		at: t(at),
		actor,
		...body,
	} as TrailEvent;
};
const SYS = { kind: "system", id: "ephyra" } as const;
const AGENT = { kind: "agent", id: "amp" } as const;
const YOU = { kind: "human", id: PRINCIPAL } as const;
const decision = (
	verdict: "approve" | "revise",
	at: string,
	note?: string,
) => ({
	by: "human" as const,
	who: PRINCIPAL,
	at: t(at),
	verdict,
	...(note ? { note } : {}),
});

export const DEMO_PROOF: ProofBundle = {
	schema: 1,
	trail: ID,
	rev: 1,
	risk: "medium",
	base: BASE,
	head: HEAD,
	items: [
		{
			kind: "repro_before",
			probe: "checkout/one-cent-drift",
			result: "fail",
			log: "proof/repro-before.log",
		},
		{
			kind: "repro_after",
			probe: "checkout/one-cent-drift",
			result: "pass",
			log: "proof/repro-after.log",
		},
		{
			kind: "tests",
			suite: "checkout",
			passed: 412,
			failed: 0,
			newFailures: 0,
			log: "proof/tests.log",
		},
		{
			kind: "regression_probes",
			ran: [
				"checkout/rounding",
				"checkout/coupons",
				"checkout/tax",
				"checkout/currency",
				"checkout/empty-cart",
				"checkout/refund",
			],
			failed: [],
		},
		{
			kind: "intent_probes",
			ran: ["checkout/totals-match-charge"],
			failed: [],
		},
		{
			kind: "traffic_replay",
			hunter: "replay/checkout",
			diffs: 3,
			unexplained: 0,
			report: "proof/replay.md",
		},
		{
			kind: "diff_scope",
			files: 2,
			lines: 31,
			exportedTypesChanged: false,
			paths: [
				"services/checkout/src/total.ts",
				"services/checkout/src/total.test.ts",
			],
		},
		{ kind: "bug_review", reviewer: "review-agent", findings: [] },
	],
	passed: true,
	missing: [],
	env: { lockHash: "devenv:3f9a1c", runner: "runner-local" },
	computedAt: t("15:19"),
};
const DIGEST = `sha256:${"4c1e0f2b".repeat(8)}`;

const trailAt = (patch: Partial<Trail>): Trail => ({
	schema: 1,
	id: ID,
	short: "T-4c1e0f",
	repo: REPO,
	title: "Checkout total off by a cent on discounted carts",
	rev: 1,
	state: "sensed",
	signals: [SIGNAL],
	area: "checkout",
	risk: "medium",
	route: "auto_fix",
	severity: 2.6,
	base: { ref: "refs/heads/main", sha: BASE },
	landing: {
		modes: ["radicle_patch"],
		target: "refs/heads/main",
		receipts: [],
	},
	checkpoints: { spend: [] },
	attempts: { proof: 0, maxProof: 3 },
	budget: {
		tokensUsed: 0,
		tokensMax: 400000,
		wallclockMaxS: 5400,
		spendMicrousdUsed: 0,
		spendMicrousdMax: 2000000,
	},
	signalFingerprint: FP,
	mirrors: {},
	createdAt: t("14:06"),
	updatedAt: t("14:06"),
	...patch,
});

/** The trail's whole life, in order. Slice it to show any moment. */
export const DEMO_EVENTS: TrailEvent[] = [
	ev("14:06", SYS, {
		type: "trail_created",
		data: {
			signalId: SIGNAL,
			title: "TotalMismatch in sumLineItems",
			baseRef: "refs/heads/main",
			baseSha: BASE,
			fingerprint: FP,
		},
	}),
	ev(
		"14:06",
		{ kind: "policy", id: "triage" },
		{
			type: "triage_completed",
			data: {
				result: {
					route: "auto_fix",
					risk: "medium",
					area: "checkout",
					severity: 2.6,
					actionable: 0.92,
					confidence: { route: 0.88, duplicateOf: 0.97 },
					backends: { extract: "clairic", decide: "judgement-jev/jev-1.14" },
					reasons: [
						"actionable 0.92 ≥ 0.6",
						"no open quest with this fingerprint",
						"area checkout: medium risk",
					],
					notifyHuman: true,
				},
			},
		},
	),
	ev("14:31", AGENT, {
		type: "research_completed",
		data: { hypothesis: "hypothesis.md" },
	}),
	ev("14:40", YOU, {
		type: "checkpoint_decided",
		data: { checkpoint: "A", decision: decision("approve", "14:40") },
	}),
	ev("14:52", AGENT, {
		type: "repro_completed",
		data: { ok: true, probe: "checkout/one-cent-drift" },
	}),
	ev("14:58", AGENT, { type: "plan_completed", data: { plan: "plan.md" } }),
	ev("15:03", YOU, {
		type: "human_comment",
		data: {
			text: "Keep the receipt rounding as is; finance reads those.",
			isRequest: false,
		},
	}),
	ev("15:04", YOU, {
		type: "checkpoint_decided",
		data: { checkpoint: "B", decision: decision("approve", "15:04") },
	}),
	ev("15:12", AGENT, {
		type: "patch_completed",
		data: { head: HEAD, revision: 1 },
	}),
	ev("15:19", SYS, {
		type: "proof_completed",
		data: { bundle: DEMO_PROOF, digest: DIGEST },
	}),
	ev("15:26", YOU, {
		type: "checkpoint_decided",
		data: { checkpoint: "C", decision: decision("approve", "15:26") },
	}),
	ev("15:27", SYS, {
		type: "landing_completed",
		data: {
			receipt: {
				mode: "radicle_patch",
				target: "refs/heads/main",
				oldOid: BASE,
				newOid: LANDED,
				externalId: "patch 9f3c2e1",
				proofDigest: DIGEST,
				at: t("15:27"),
			},
		},
	}),
	ev("15:27", SYS, {
		type: "watch_started",
		data: {
			config: {
				windowS: 7200,
				fingerprints: [FP],
				touchedFiles: ["services/checkout/src/total.ts"],
				routes: ["POST /checkout"],
				areaProbes: ["checkout/totals-match-charge", "checkout/one-cent-drift"],
				baseline: { errorRate: 0.004, p95Ms: 380 },
				startedAt: t("15:27"),
			},
		},
	}),
	ev("17:27", SYS, { type: "watch_completed", data: { outcome: "clean" } }),
];

/** How many events each moment includes, and the trail's state then. */
export const DEMO_MOMENTS = {
	triaged: { events: 2, state: "researching" },
	hypothesis: { events: 3, state: "hypothesised" },
	plan: { events: 7, state: "planned" },
	proof: { events: 10, state: "ready" },
	watching: { events: 13, state: "watching" },
	set: { events: 14, state: "closed" },
} as const satisfies Record<string, { events: number; state: Trail["state"] }>;
export type DemoMoment = keyof typeof DEMO_MOMENTS;

export function demoTrail(moment: DemoMoment): {
	trail: Trail;
	events: TrailEvent[];
} {
	const m = DEMO_MOMENTS[moment];
	const events = DEMO_EVENTS.slice(0, m.events);
	const last = events[events.length - 1]!;
	const decided = (k: "A" | "B" | "C") => {
		const e = events.find(
			(x) => x.type === "checkpoint_decided" && x.data.checkpoint === k,
		);
		return e && e.type === "checkpoint_decided" ? e.data.decision : undefined;
	};
	const receipts = events.flatMap((e) =>
		e.type === "landing_completed" ? [e.data.receipt] : [],
	);
	const trail = trailAt({
		state: m.state,
		updatedAt: last.at,
		...(events.some((e) => e.type === "patch_completed") ? { head: HEAD } : {}),
		attempts: {
			proof: events.some((e) => e.type === "proof_completed") ? 1 : 0,
			maxProof: 3,
		},
		checkpoints: {
			...(decided("A") ? { A: decided("A")! } : {}),
			...(decided("B") ? { B: decided("B")! } : {}),
			...(decided("C") ? { C: decided("C")! } : {}),
			spend: [],
		},
		landing: { modes: ["radicle_patch"], target: "refs/heads/main", receipts },
		budget: {
			tokensUsed: Math.round(31000 * m.events),
			tokensMax: 400000,
			wallclockMaxS: 5400,
			spendMicrousdUsed: 0,
			spendMicrousdMax: 2000000,
		},
		mirrors: { ampThread: "T-019a4c1e-0f2b" },
	});
	return { trail, events };
}

const item = (patch: Partial<InboxItem>): InboxItem => ({
	trailId: ID,
	short: "T-4c1e0f",
	title: "Checkout total off by a cent on discounted carts",
	area: "checkout",
	risk: "medium",
	severity: 2.6,
	state: "hypothesised",
	bound: { rev: 1 },
	kind: "checkpoint",
	checkpoint: "A",
	blocking: true,
	artefact: {
		path: "hypothesis.md",
		summary: "Hypothesis: is this the right cause to chase?",
	},
	landingUrl: "https://ampcode.com/threads/T-019a4c1e-0f2b",
	evidenceIndex: "evidence/index.json",
	createdAt: t("14:31"),
	...patch,
});

/** The demo trail as an inbox item at each checkpoint. */
export const DEMO_ITEMS = {
	A: item({}),
	B: item({
		state: "planned",
		checkpoint: "B",
		artefact: {
			path: "plan.md",
			summary: "Plan: reproduced; approve the fix approach",
		},
		createdAt: t("14:58"),
	}),
	C: item({
		state: "ready",
		checkpoint: "C",
		bound: { rev: 1, head: HEAD, proofDigest: DIGEST },
		artefact: {
			path: "proof/manifest.json",
			summary: "Proof passed: approve landing",
		},
		createdAt: t("15:19"),
	}),
};

/** Other things waiting, so the inbox looks like a working day. */
export const DEMO_OTHERS: InboxItem[] = [
	{
		trailId: "0193f2b6-90aa-7bb1-8cc2-1d2e3f405162",
		short: "T-405162",
		title: "Search returns stale results after reindex",
		area: "search",
		risk: "high",
		severity: 3.1,
		state: "parked",
		bound: { rev: 2 },
		kind: "parked",
		blocking: false,
		artefact: {
			path: "trail.json",
			summary: "Proof failed 3 times: the reindex job races the cache warmer",
		},
		createdAt: t("13:12"),
	},
	{
		trailId: "0193f2b6-91bb-7cc2-8dd3-2e3f40516273",
		short: "T-516273",
		title: "Persona study for the new onboarding copy",
		area: "onboarding",
		risk: "medium",
		severity: 1.4,
		state: "proving",
		bound: { rev: 1 },
		kind: "spend",
		blocking: true,
		artefact: {
			path: "trail.json",
			summary: "voxq study, 40 respondents: up to $18.00",
		},
		createdAt: t("14:44"),
	},
	{
		trailId: "0193f2b6-92cc-7dd3-8ee4-3f4051627384",
		short: "T-627384",
		title: "Typo in the password reset email",
		area: "docs",
		risk: "low",
		severity: 0.4,
		state: "hypothesised",
		bound: { rev: 1 },
		kind: "checkpoint",
		checkpoint: "A",
		blocking: false,
		shadowVerdict: "approve",
		artefact: { path: "hypothesis.md", summary: "Hypothesis: one word" },
		createdAt: t("14:50"),
	},
];

// ───── A second trail, the one that doesn't set ─────

const RB = "0193f2b6-93dd-7ee4-8ff5-405162738495";
const RB_BASE = "1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d";
const RB_HEAD = "6d8f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d5f";
const RB_LANDED = "c9e1b3d5f7a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8";
const RB_REVERT = "e2a4c6e8b0d1f3a5c7e9b2d4f6a8c0e1b3d5f7a9";
const RB_PRINT = "fp:search/suggest.ts:88:TimeoutError";
const rbEv = (
	at: string,
	actor: TrailEvent["actor"],
	body: Omit<TrailEvent, "schema" | "id" | "trail" | "rev" | "at" | "actor">,
	rev = 1,
) => ({ ...ev(at, actor, body, rev), trail: RB }) as TrailEvent;
const RB_PROOF: ProofBundle = {
	...DEMO_PROOF,
	trail: RB,
	risk: "low",
	base: RB_BASE,
	head: RB_HEAD,
	computedAt: t("11:20"),
	items: [
		{
			kind: "repro_before",
			probe: "search/suggest-latency",
			result: "fail",
			log: "proof/repro-before.log",
		},
		{
			kind: "repro_after",
			probe: "search/suggest-latency",
			result: "pass",
			log: "proof/repro-after.log",
		},
		{
			kind: "tests",
			suite: "search",
			passed: 188,
			failed: 0,
			newFailures: 0,
			log: "proof/tests.log",
		},
		{
			kind: "diff_scope",
			files: 1,
			lines: 9,
			exportedTypesChanged: false,
			paths: ["services/search/src/suggest.ts"],
		},
	],
};
export const DEMO_ROLLBACK_EVENTS: TrailEvent[] = [
	rbEv("10:41", SYS, {
		type: "trail_created",
		data: {
			signalId: SIGNAL,
			title: "TimeoutError in suggest",
			baseRef: "refs/heads/main",
			baseSha: RB_BASE,
			fingerprint: RB_PRINT,
		},
	}),
	rbEv(
		"10:42",
		{ kind: "policy", id: "triage" },
		{
			type: "triage_completed",
			data: {
				result: {
					route: "auto_fix",
					risk: "low",
					area: "search-ui",
					severity: 1.8,
					actionable: 0.81,
					confidence: { route: 0.84, duplicateOf: 0.95 },
					backends: { extract: "clairic", decide: "judgement-jev/jev-1.14" },
					reasons: ["loose edge: lands unattended"],
					notifyHuman: false,
				},
			},
		},
	),
	rbEv("11:20", SYS, {
		type: "proof_completed",
		data: { bundle: RB_PROOF, digest: `sha256:${"9b0d2f4a".repeat(8)}` },
	}),
	rbEv("11:21", SYS, {
		type: "landing_completed",
		data: {
			receipt: {
				mode: "auto_land",
				target: "refs/heads/main",
				oldOid: RB_BASE,
				newOid: RB_LANDED,
				at: t("11:21"),
			},
		},
	}),
	rbEv("11:21", SYS, {
		type: "watch_started",
		data: {
			config: {
				windowS: 3600,
				fingerprints: [RB_PRINT],
				touchedFiles: ["services/search/src/suggest.ts"],
				routes: ["GET /suggest"],
				areaProbes: ["search/suggest-latency"],
				baseline: { errorRate: 0.002, p95Ms: 120 },
				startedAt: t("11:21"),
			},
		},
	}),
	rbEv("11:48", SYS, {
		type: "probe_regressed_after_landing",
		data: {
			criterion: "new fingerprint in a touched file: suggest.ts:91 RangeError",
			evidence: "watch/observations.json",
		},
	}),
	rbEv("11:49", SYS, {
		type: "rollback_completed",
		data: {
			receipt: {
				mode: "auto_land",
				target: "refs/heads/main",
				oldOid: RB_LANDED,
				newOid: RB_REVERT,
				at: t("11:49"),
			},
		},
	}),
];
export const DEMO_ROLLBACK: { trail: Trail; events: TrailEvent[] } = {
	trail: trailAt({
		id: RB,
		short: "T-738495",
		title: "Suggestions time out on long queries",
		rev: 2,
		state: "researching",
		area: "search-ui",
		risk: "low",
		severity: 1.8,
		base: { ref: "refs/heads/main", sha: RB_BASE },
		head: RB_HEAD,
		signalFingerprint: RB_PRINT,
		landing: { modes: ["auto_land"], target: "refs/heads/main", receipts: [] },
		watchEvidence: "watch/observations.json",
		attempts: { proof: 0, maxProof: 3 },
		createdAt: t("10:41"),
		updatedAt: t("11:49"),
	}),
	events: DEMO_ROLLBACK_EVENTS,
};

/** Journal files for the demo trail, as the file route would serve them. */
export const DEMO_FILES: Record<string, string> = {
	"hypothesis.md": DEMO_TEXT.hypothesis,
	"plan.md": DEMO_TEXT.plan,
	"evidence/index.json": DEMO_TEXT.evidence,
};

/** A plain trail for any of the other example items, so every row has something to show. */
export function demoTrailFor(item: InboxItem): {
	trail: Trail;
	events: TrailEvent[];
} {
	if (item.trailId === ID)
		return demoTrail(
			item.kind === "checkpoint" && item.checkpoint
				? ({ A: "hypothesis", B: "plan", C: "proof" } as const)[item.checkpoint]
				: "watching",
		);
	const at = item.createdAt;
	const sig = `${item.trailId.slice(0, 24)}aaaaaaaaaaaa`;
	const e = (
		k: number,
		actor: TrailEvent["actor"],
		body: Omit<TrailEvent, "schema" | "id" | "trail" | "rev" | "at" | "actor">,
	) =>
		({
			schema: 1,
			id: `${item.trailId.slice(0, 24)}${k.toString(16).padStart(12, "0")}`,
			trail: item.trailId,
			rev: item.bound.rev,
			at,
			actor,
			...body,
		}) as TrailEvent;
	const events: TrailEvent[] = [
		e(1, SYS, {
			type: "trail_created",
			data: {
				signalId: sig,
				title: item.title,
				baseRef: "refs/heads/main",
				baseSha: BASE,
			},
		}),
		e(
			2,
			{ kind: "policy", id: "triage" },
			{
				type: "triage_completed",
				data: {
					result: {
						route: item.kind === "spend" ? "research_only" : "auto_fix",
						risk: item.risk,
						area: item.area,
						severity: item.severity,
						actionable: 0.8,
						confidence: { route: 0.8, duplicateOf: 0.9 },
						backends: { extract: "clairic", decide: "judgement-jev/jev-1.14" },
						reasons: [],
						notifyHuman: false,
					},
				},
			},
		),
	];
	if (item.kind === "parked")
		events.push(
			e(3, SYS, { type: "parked", data: { reason: item.artefact.summary } }),
		);
	if (item.kind === "spend")
		events.push(
			e(3, AGENT, {
				type: "spend_requested",
				data: { purpose: "voxq study, 40 respondents", microusd: 18_000_000 },
			}),
		);
	const trail = trailAt({
		id: item.trailId,
		short: item.short,
		title: item.title,
		rev: item.bound.rev,
		state: item.state,
		area: item.area,
		risk: item.risk,
		severity: item.severity,
		signals: [sig],
		landing: undefined,
		createdAt: at,
		updatedAt: at,
		...(item.state === "parked" ? { resumeTo: "proving" as const } : {}),
		...(item.kind === "spend"
			? {
					pendingSpend: {
						purpose: "voxq study, 40 respondents",
						microusd: 18_000_000,
					},
				}
			: {}),
	});
	return { trail, events };
}
