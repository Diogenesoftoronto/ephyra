// Signal → triage → trail. Runs as a job so OTLP requests return immediately.
// Extraction and judgement go to whichever backends the registry resolves; without a decide backend the
// signal still becomes a trail, routed to a human (never an automatic fix on unknown judgement).
import {
  createTrail, Signal, type Budget, type DecideBackend, type ExtractBackend, type ExtractionResponse, type Trail,
  type TriageResult,
} from "@ephyra/core";
import { applyTriage, areaFor, buildExtractionRequest, buildTriageRequest, type Candidates } from "@ephyra/policy";
import type { HandlerSlice, ServerContext } from "./context.ts";

export type IntakeDeps = {
  extract: ExtractBackend | null;
  decide: DecideBackend | null;
  /** Resolve the current base commit of the repo (e.g. `git rev-parse` in the mirror). */
  baseSha(): Promise<string>;
  budget: Budget;
};

const OPEN: Trail["state"][] = [
  "sensed", "triaged", "researching", "hypothesised", "reproducing", "planned", "patching", "proving", "ready",
  "landing", "parked", "handed_off",
];
const IN_FLIGHT: Trail["state"][] = ["patching", "proving", "ready", "landing", "watching"];

async function candidates(ctx: ServerContext): Promise<Candidates> {
  const pick = (t: Trail) => ({ id: t.id, title: t.title });
  const [open, inFlight, closed] = await Promise.all([
    ctx.trails.list({ states: OPEN }), ctx.trails.list({ states: IN_FLIGHT }), ctx.trails.list({ states: ["closed"] }),
  ]);
  const recent = (ts: Trail[]) => ts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return { open: recent(open).map(pick), inFlight: recent(inFlight).map(pick), closed: recent(closed).map(pick) };
}

/** No decide backend: every signal goes to a human, with the reason recorded. */
function humanTriage(area: string, risk: TriageResult["risk"], why: string): TriageResult {
  return {
    route: "human", risk, area, severity: 2, actionable: 0.5, notifyHuman: true,
    confidence: { route: 0, duplicateOf: 0 }, backends: { decide: "none" }, reasons: [why],
  };
}

export async function triageSignal(ctx: ServerContext, deps: IntakeDeps, signal: Signal, jobKey: string): Promise<void> {
  const files = signal.frames.filter((f) => f.inApp).map((f) => f.file);
  const area = areaFor(ctx.policy.autonomy, files);
  let extraction: ExtractionResponse = { model: "none", answers: {} };
  if (deps.extract) extraction = await deps.extract.extract(buildExtractionRequest(signal), { idempotencyKey: `${jobKey}:extract` });

  let triage: TriageResult;
  if (!deps.decide) {
    triage = humanTriage(area.name, area.risk, "no decide backend configured");
  } else {
    const cands = await candidates(ctx);
    const judgement = await deps.decide.decide(buildTriageRequest(signal, extraction, cands, area), {
      idempotencyKey: `${jobKey}:decide`,
    });
    triage = applyTriage(judgement, extraction, ctx.policy.thresholds, area, cands, signal.kind);
    if (extraction.model !== "none") triage.backends.extract = extraction.model;
  }

  const id = ctx.ids.uuidv7();
  const now = ctx.clock.now().toISOString();
  const regressionTrail = triage.regressionOf ? await ctx.trails.get(triage.regressionOf) : null;
  if (triage.regressionOf && regressionTrail?.state !== "closed") {
    triage.reasons.push("regression target is not a closed trail; treated as a new trail");
    delete triage.regressionOf;
  }
  const result = createTrail({
    id, signal, title: signal.title.slice(0, 200), repo: ctx.repo.id,
    base: { ref: ctx.repo.baseRef, sha: await deps.baseSha() }, triage, now, budget: deps.budget,
    ...(regressionTrail && triage.regressionOf ? { regressionTrail } : {}),
  });

  ctx.log("signal triaged", {
    fingerprint: signal.fingerprint, route: triage.route, area: triage.area, decide: triage.backends.decide,
    trail: result.trail?.short ?? null, reasons: triage.reasons,
  });
  if (!result.trail) {
    // Duplicate: the merge effect attaches the signal to the existing trail.
    for (const effect of result.effects) {
      if (effect.type === "merge_signal") {
        await ctx.emit({ trail: effect.into, actor: { kind: "system", id: "intake" }, type: "new_signal",
          data: { signalId: signal.id, severity: triage.severity } });
      }
    }
    return;
  }
  const initial = {
    schema: 1 as const, id: ctx.ids.uuidv7(), trail: result.trail.id, rev: result.trail.rev, at: now,
    actor: { kind: "system" as const, id: "intake" }, type: "triage_completed" as const, data: { result: triage },
  };
  await ctx.start(result.trail, initial, result.effects);
}

/** Registers the triage job and returns the hook for new signals. */
export function intake(ctx: ServerContext, deps: IntakeDeps) {
  ctx.jobs.register("triage", async (payload, job) => {
    await triageSignal(ctx, deps, Signal.parse(payload), job.key);
  });
  return {
    // One deployment drives one repository; every service it ingests from belongs to that repo.
    // (Ingest fills Signal.repo from service.name, which stays visible as Signal.service.)
    onNewSignal: async (signal: Signal) => {
      await ctx.jobs.enqueue("triage", `triage:${signal.id}`, { ...signal, repo: ctx.repo.id });
    },
  };
}

/** Effects owned by intake. */
export function intakeHandlers(ctx: ServerContext): HandlerSlice {
  return {
    run_triage: async (effect) => {
      const signal = await ctx.signals.get(effect.signalId);
      if (!signal) throw new Error(`signal ${effect.signalId} not found`);
      await ctx.jobs.enqueue("triage", `triage:${signal.id}`, signal);
    },
    merge_signal: async (effect) => {
      await ctx.emit({ trail: effect.into, actor: { kind: "system", id: "intake" }, type: "new_signal",
        data: { signalId: effect.signalId } });
    },
    mute_fingerprint: async (effect) => {
      await ctx.signals.mute(effect.fingerprint, new Date(ctx.clock.now().getTime() + effect.forS * 1000));
    },
  };
}
