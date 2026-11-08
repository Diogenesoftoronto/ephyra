// The activity feed: what the personas are doing now (running and queued jobs), what waits for a human (inbox), and what they did
// recently (trail events). Summaries are plain sentences built from fixed templates plus the trail's short name; free text from signals
// (titles, messages) never reaches a summary.
import { TERMINAL_STATES, personaFor, type ActivityItem, type PersonaId, type Trail, type TrailEvent } from "@ephyra/core";
import type { RuntimeStore } from "./wiring/store.ts";

type Item = ActivityItem;
const TRAILS_SCANNED = 60;
const EVENTS_PER_TRAIL = 12;

const STEP_VERB: Record<string, (s: string) => string> = {
  research: (s) => `Researching the cause of ${s}`,
  repro: (s) => `Writing the failing reproduction for ${s}`,
  plan: (s) => `Planning the smallest fix for ${s}`,
  patch: (s) => `Writing the patch for ${s}`,
  review: (s) => `Reviewing the patch for ${s}`,
};
const STEP_NOUN: Record<string, string> = { research: "research", repro: "reproduction", plan: "plan", patch: "patch", review: "review" };

function fromEvent(trail: Trail, e: TrailEvent): Item | null {
  const s = trail.short;
  const make = (persona: PersonaId | null, status: Item["status"], summary: string): Item => ({
    id: `event:${e.id}`, at: e.at, persona, status, summary, trailId: trail.id, short: s,
    engine: e.actor.kind === "agent" || e.actor.kind === "policy" ? e.actor.id : null,
  });
  switch (e.type) {
    case "trail_created": return make("rho", "done", `Opened trail ${s} from a new signal`);
    case "triage_completed": return make("rho", "done", `Triaged the signal for ${s}`);
    case "research_completed": return make("bell", "done", `Wrote the hypothesis for ${s}`);
    case "checkpoint_decided": return make("rho", "done",
      `${e.data.decision.by === "policy" ? "Model" : "Human"} checkpoint ${e.data.checkpoint}: ${e.data.decision.verdict} for ${s}`);
    case "repro_completed":
      return e.data.ok ? make("nema", "done", `Wrote a failing reproduction for ${s}`) : make("nema", "failed", `Could not reproduce the failure for ${s}`);
    case "plan_completed": return make("lappet", "done", `Planned the fix for ${s}`);
    case "patch_completed": return make("lappet", "done", `Wrote revision ${e.data.revision} of the patch for ${s}`);
    case "proof_completed":
      return e.data.bundle.passed ? make("nema", "done", `Proof passed for ${s}`) : make("nema", "failed", `Proof did not pass for ${s}`);
    case "landing_completed": return make("turri", "done", `Landed ${s}`);
    case "landing_failed": return make("turri", "failed", `Landing ${s} failed`);
    case "watch_started": return make("turri", "done", `Started watching ${s} after landing`);
    case "watch_completed": return make("turri", "done", `Finished watching ${s}: no regression`);
    case "probe_regressed_after_landing": return make("turri", "failed", `The error came back after landing ${s}`);
    case "rollback_completed": return make("turri", "done", `Rolled back ${s}`);
    case "agent_failed": {
      const step = STEP_NOUN[e.data.step] ?? e.data.step;
      return make(personaFor(e.data.step), "failed", `The ${step} step failed for ${s}`);
    }
    default: return null;
  }
}

const WAITING_ON: Record<"A" | "B" | "C", { persona: PersonaId; what: string }> = {
  A: { persona: "bell", what: "the hypothesis" }, B: { persona: "lappet", what: "the plan" }, C: { persona: "nema", what: "the proof" },
};

export type ActivityDeps = { store: RuntimeStore; now: () => Date };

export async function activity(deps: ActivityDeps, limit: number): Promise<ActivityItem[]> {
  const { store } = deps;
  const trails = await store.listTrails();
  const byId = new Map(trails.map((t) => [t.id, t]));
  const items: Item[] = [];

  for (const job of (await store.activeJobs?.()) ?? []) {
    const p = (job.payload ?? {}) as { trailId?: string; step?: string; tick?: number };
    const trail = p.trailId ? byId.get(p.trailId) ?? null : null;
    const short = trail?.short ?? null;
    const running = job.status === "running";
    const at = (running ? job.startedAt : undefined) ?? job.runAt;
    let persona: PersonaId | null = null;
    let summary: string | null = null;
    if (job.kind === "agent_step" && p.step) {
      persona = personaFor(p.step);
      const verb = STEP_VERB[p.step]?.(short ?? "a trail");
      summary = running ? verb ?? `Running the ${p.step} step` : `Next up: ${(verb ?? `the ${p.step} step`).replace(/^./, (c) => c.toLowerCase())}`;
    } else if (job.kind === "proof") {
      persona = "nema";
      summary = running ? `Running the proof for ${short ?? "a trail"}` : `Next up: running the proof for ${short ?? "a trail"}`;
    } else if (job.kind === "triage") {
      persona = "rho";
      summary = running ? "Triaging a new signal" : "A new signal is waiting to be triaged";
    } else if (job.kind === "watch") {
      persona = "turri";
      summary = running ? `Checking ${short ?? "a trail"} after landing` : `Next check of ${short ?? "a trail"} after landing is scheduled`;
    } else if (job.kind === "automatic_setup") {
      summary = running ? "Preparing repository autonomy and checking execution readiness" : "Automatic repository setup is queued";
    } else if (job.kind === "checkpoint_evaluation") {
      persona = "rho";
      summary = running ? `Checking the evidence before continuing ${short ?? "a trail"}` : "A machine checkpoint is queued";
    }
    if (!summary) continue;
    items.push({
      id: `job:${job.key}`, at: at.toISOString(), persona, status: running ? "running" : "waiting", summary: summary.slice(0, 300),
      trailId: trail?.id ?? null, short, engine: null, ...(running ? { startedAt: at.toISOString() } : {}),
    });
  }

  for (const entry of await store.inboxList()) {
    if ((entry.kind !== "checkpoint" && entry.kind !== "spend") || !entry.blocking) continue;
    const w = entry.checkpoint ? WAITING_ON[entry.checkpoint] : null;
    items.push({
      id: `inbox:${entry.id}`, at: entry.createdAt, persona: w?.persona ?? null, status: "waiting", trailId: entry.trailId, short: entry.short, engine: null,
      summary: entry.kind === "spend" ? `Waiting for you to approve spend on ${entry.short}`
        : `Waiting for you to review ${w?.what ?? "a checkpoint"} for ${entry.short}`,
    });
  }

  const recent = [...trails].sort((a, b) => Number(TERMINAL_STATES.includes(a.state)) - Number(TERMINAL_STATES.includes(b.state))).slice(0, TRAILS_SCANNED);
  const events = await Promise.all(recent.map(async (t) => (await store.events(t.id)).map(event => fromEvent(t, event))
    .filter((item): item is Item => item !== null).slice(-EVENTS_PER_TRAIL)));
  items.push(...events.flat());

  const rank = (i: Item) => (i.status === "running" ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at)).slice(0, limit);
}
