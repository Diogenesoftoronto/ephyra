// Agent steps and proof. Each runs as a job: allocate a sandbox at the trail's current commit, run one
// step with the coding agent, write artefacts into the journal, emit the next event, destroy the sandbox.
// No sandbox is kept alive while a trail waits on a human.
import { evaluateProof } from "@ephyra/policy";
import { ReconciliationRequired, Unverified, personaFor } from "@ephyra/core";
import { ClaudeCodeAgent, CodexAgent, executorOf, redact, runAgent, type ExecutorInfo, type ProofOptions } from "@ephyra/agent";
import type {
  AgentStep, AgentTask, CodingAgent, ProofBundle, ProofItem, Runner, RunnerHandle, ServiceProfile, Signal, Trail,
} from "@ephyra/core";
import type { HandlerSlice, ServerContext } from "./context.ts";
import type { BilledTo, UsageRecorder } from "../usage.ts";
import type { RunHandle, RunRecorder } from "../runs.ts";
import { gatherResearchEvidence } from "./research-evidence.ts";
import { buildRecovery } from "./recovery.ts";
import { importRunnerPatch } from "../setup/repository-bundle.ts";

export type BuildProofFn = (options: {
  runner: Runner; handle: RunnerHandle; trail: Trail; base: string; head: string; probe: string;
  evaluate: (items: ProofItem[], trail: Trail) => { passed: boolean; missing: string[] };
  prepareRevision?: ProofOptions["prepareRevision"];
}) => Promise<ProofBundle>;

export type AgentDeps = {
  runner: Runner | null;
  agent: CodingAgent | null;
  profile: ServiceProfile;
  buildProof: BuildProofFn;
  /** Wallclock per agent step. */
  stepTimeoutS: number;
  /** Usage ledger. Without it nothing is recorded (tests that don't care). */
  usage?: UsageRecorder;
  /** Who pays for the coding agent: its CLI login ("local"), a provider key ("byok"), or unknown. */
  agentBilledTo?: BilledTo;
  /** Live run records for the console. Without it steps run exactly the same, just unobserved. */
  runs?: RunRecorder;
  /** Exact secret values to scrub from run events (on top of pattern-based redaction). */
  secrets?: string[];
  evidenceSources?: import("@ephyra/core").EvidenceSource[];
  resolveEvidenceSources?: () => Promise<import("@ephyra/core").EvidenceSource[]>;
  prepareProof?: (runner: Runner, handle: RunnerHandle, trail: Trail) => Promise<ProofOptions["prepareRevision"]>;
};

type StepPayload = { trailId: string; rev: number; step: AgentStep; note?: string; operationKey?: string };
type ProofPayload = { trailId: string; rev: number; operationKey?: string };

const decoder = new TextDecoder();

async function untrustedFor(ctx: ServerContext, trail: Trail): Promise<Record<string, string>> {
  const signals = (await Promise.all(trail.signals.slice(0, 3).map((id) => ctx.signals.get(id)))).filter(Boolean) as Signal[];
  const out: Record<string, string> = {};
  signals.forEach((s, i) => {
    out[`signal_${i + 1}`] = [
      s.title, s.message, s.exceptionType ?? "", ...s.frames.slice(0, 12).map((f) => `  at ${f.fn ?? "?"} (${f.file}:${f.line ?? "?"})`),
    ].join("\n");
  });
  const answer = await ctx.journal.readFile(trail.id, "questions/latest.json");
  if (answer) out.investigation_answer = decoder.decode(answer).slice(0, 20_000);
  return out;
}

async function contextFor(ctx: ServerContext, trail: Trail, note?: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    trail: `${trail.short} ${trail.title} (area ${trail.area}, risk ${trail.risk}, rev ${trail.rev})`,
  };
  for (const path of ["hypothesis.md", "plan.md"]) {
    const data = await ctx.journal.readFile(trail.id, path);
    if (data) out[path] = decoder.decode(data);
  }
  const area = ctx.policy.autonomy.areas.find((a) => a.name === trail.area);
  if (area?.prose) out.policy = area.prose;
  if (note) out.human_note = note;
  if (trail.watchEvidence) out.watch_evidence = trail.watchEvidence;
  return out;
}

/** Push the agent's head commit from the sandbox into the workspace repo, as an immutable revision ref. */
async function publishHead(runner: Runner, handle: RunnerHandle, ctx: ServerContext, trail: Trail, head: string) {
  const ref = `refs/ephyra/trails/${trail.id}/revisions/${String(trail.rev + 1).padStart(4, "0")}`;
  await importRunnerPatch(runner, handle, ctx.repo.mirrorDir, head, ref);
}

/** Commit identifying the code the step should run against. */
function commitFor(trail: Trail): string { return trail.head ?? trail.base.sha; }

async function withSandbox<T>(deps: AgentDeps, ctx: ServerContext, trail: Trail, attempt: number, operationKey: string,
  work: (runner: Runner, handle: RunnerHandle) => Promise<T>): Promise<T> {
  if (!deps.runner) throw new Error("no runner configured on this deployment");
  const runner = deps.runner;
  const handle = await runner.allocate({
    trail, attempt, repoUrl: ctx.repo.url, commit: commitFor(trail), profile: deps.profile, leaseS: deps.stepTimeoutS + 300, operationKey,
  });
  try {
    return await work(runner, handle);
  } finally {
    await runner.destroy(handle).catch((error) => ctx.log("sandbox destroy failed", { error: String(error) }));
  }
}

/** Engine identity as the agent reported it, e.g. "claude-code/claude-opus-5-5". */
function engineOf(agent: CodingAgent | null, model?: string): string {
  if (!agent) return "none";
  return !model || model === agent.name ? agent.name : `${agent.name}/${model}`;
}

/** Where the step executes: the agent's own executor when it has a remote one (Amp orb or runner), otherwise the runner it was given. */
function executorFor(agent: CodingAgent, runner: Runner): ExecutorInfo {
  const own = executorOf(agent);
  if (own && own.kind !== "local") return own;
  const kinds: Record<string, ExecutorInfo["kind"]> = { local: "local", notorganic: "notorganic", railway: "railway" };
  const kind = kinds[runner.name];
  return { ...(own ?? {}), ...(kind ? { kind } : { kind: "runner" as const, id: runner.name }) };
}

async function runStep(ctx: ServerContext, deps: AgentDeps, payload: StepPayload, attempt: number): Promise<void> {
  const trail = await ctx.trails.get(payload.trailId);
  if (!trail || trail.rev !== payload.rev) return; // superseded; a newer effect owns the trail now
  const actor = { kind: "agent" as const, id: deps.agent?.name ?? "none" };
  const started = Date.now();
  const record = (outcome: "ok" | "failed" | "unavailable", extra: { engine?: string; tokens?: number | null; cost?: number | null; note?: string }) =>
    deps.usage?.record({
      idempotencyKey: `agent_step:${trail.id}:${trail.rev}:${payload.step}:${attempt}`, kind: "agent_step", persona: personaFor(payload.step),
      step: payload.step, engine: extra.engine ?? engineOf(deps.agent), trailId: trail.id, short: trail.short, tokens: extra.tokens ?? null,
      costMicrousd: extra.cost ?? null, wallMs: Date.now() - started, outcome, billedTo: deps.agentBilledTo ?? "unknown",
      ...(extra.note ? { note: extra.note } : {}),
    });
  if (!deps.agent || !deps.runner) {
    await record("unavailable", { note: "no coding agent or runner configured on this deployment" });
    await ctx.emit({ trail: trail.id, actor, type: "agent_failed",
      data: { step: payload.step, reason: "no coding agent or runner configured on this deployment", retryable: false } });
    return;
  }
  const events = await ctx.trails.events(trail.id);
  const recovery = buildRecovery(trail, events, payload.step, {
    retrySafety: deps.profile.readOnlyProd && deps.profile.credentials.length === 0 ? "isolated" : "unknown",
    canResetContext: deps.agent instanceof CodexAgent || deps.agent instanceof ClaudeCodeAgent || deps.agent.name === "account-model",
    secrets: deps.secrets,
  });
  const recoveryFiles = { [`artefacts/recovery/${payload.step}-${trail.rev}-${recovery.attempt}.json`]: JSON.stringify(recovery.artifact) };
  if (recovery.exhausted) {
    await ctx.emit({ trail: trail.id, actor, type: "parked", data: { reason: recovery.artifact.reason ?? "Recovery needs new evidence." },
      files: recoveryFiles });
    return;
  }
  const evidence = ["research", "repro"].includes(payload.step)
    ? await gatherResearchEvidence([
      ...(deps.evidenceSources ?? []), ...(await deps.resolveEvidenceSources?.() ?? []),
    ], trail, trail.title, { secrets: deps.secrets, timeoutMs: 30_000 })
    : { untrusted: {}, files: {} };
  const task: AgentTask = {
    step: payload.step, trail, untrusted: { ...await untrustedFor(ctx, trail), ...evidence.untrusted, recovery: recovery.untrustedHistory },
    context: { ...await contextFor(ctx, trail, payload.note), recovery: recovery.instruction },
    budget: { tokens: trail.budget.tokensMax - trail.budget.tokensUsed, wallclockS: deps.stepTimeoutS },
  };
  let result;
  const agent = deps.agent;
  const run: RunHandle | undefined = await deps.runs?.start({
    id: `${trail.id}.${trail.rev}.${payload.step}.${attempt}`, trailId: trail.id, short: trail.short, step: payload.step,
    persona: personaFor(payload.step), engine: engineOf(agent), executor: executorFor(agent, deps.runner),
  });
  try {
    result = await withSandbox(deps, ctx, trail, attempt,
      `${payload.operationKey ?? `${trail.id}:${trail.rev}:${payload.step}`}:${attempt}`, async (runner, handle) => {
      // The launcher's sandbox id is not an Amp orb or remote Amp runner id.
      // Remote agent identity is reported by that agent; never overwrite it with the launcher's handle.
      if (run && (!executorOf(agent) || executorOf(agent)?.kind === "local")) run.executor({ id: handle.id });
      const r = await runAgent(agent, task, runner, handle, {
        ...(run ? { onEvent: run.event, onExecutor: run.executor } : {}), ...(deps.secrets ? { secrets: deps.secrets } : {}),
      });
      if (r.ok && payload.step === "patch" && r.outputs.head) await publishHead(runner, handle, ctx, trail, r.outputs.head);
      return r;
    });
  } catch (error) {
    // Output we could not verify (Unverified) is unavailable evidence, not an observed failure.
    await record(error instanceof Unverified ? "unavailable" : "failed", { note: String(error) });
    await run?.finish({ status: error instanceof Unverified ? "unavailable" : "failed", error: String(error) });
    await ctx.emit({ trail: trail.id, actor, type: "agent_failed",
      data: { step: payload.step, reason: redact(String(error), deps.secrets ?? [], 500),
        retryable: !(error instanceof ReconciliationRequired) && recovery.attempt < 3 && recovery.artifact.retrySafety === "isolated" },
      files: { ...evidence.files, ...recoveryFiles } });
    return;
  }
  const spent = { engine: engineOf(deps.agent, result.usage.model), tokens: result.usage.tokens, cost: result.usage.costMicrousd };
  // A failed turn's artefacts are not successful step evidence (e.g. Amp reauthentication).
  if (!result.ok) {
    await record("failed", { ...spent, note: result.error ?? "coding agent returned an unsuccessful turn" });
    await run?.finish({ status: "failed", engine: spent.engine, usage: { tokens: spent.tokens, costMicrousd: spent.cost },
      error: result.error ?? "coding agent returned an unsuccessful turn" });
    await ctx.emit({ trail: trail.id, actor, type: "agent_failed",
      data: { step: payload.step, reason: result.error ?? "coding agent returned an unsuccessful turn", retryable: false },
      files: { ...evidence.files, ...recoveryFiles } });
    return;
  }
  await record("ok", spent);
  await run?.finish({ status: "done", engine: spent.engine, usage: { tokens: spent.tokens, costMicrousd: spent.cost } });
  // Link the agent's own thread (Amp) to the trail the first time we see it, so the inbox can open it.
  const thread = result.outputs.ampThread;
  if (thread && trail.mirrors.ampThread !== thread) {
    await ctx.emit({ trail: trail.id, actor, type: "mirror_linked", data: { kind: "ampThread", id: thread } });
  }
  const files: Record<string, string> = { ...evidence.files, ...recoveryFiles };
  for (const [path, content] of Object.entries(result.artefacts)) files[`artefacts/${payload.step}/${path}`] = content;
  if (result.sessions.length) files[`sessions/${payload.step}.json`] = JSON.stringify(result.sessions);

  switch (payload.step) {
    case "research": {
      const hypothesis = result.artefacts["hypothesis.md"];
      if (!hypothesis) throw new Error("research produced no hypothesis.md");
      return ctx.emit({ trail: trail.id, actor, type: "research_completed", data: { hypothesis: "hypothesis.md" },
        files: { ...files, "hypothesis.md": hypothesis } });
    }
    case "repro": {
      const probe = result.outputs.probe;
      const script = probe ? result.artefacts[probe] : undefined;
      if (probe && !script) throw new Error("repro reported a probe but returned no probe content");
      // The probe is kept in the journal: the sandbox that wrote it is destroyed after this step.
      return ctx.emit({ trail: trail.id, actor, type: "repro_completed",
        data: probe ? { ok: true, probe } : { ok: false, reason: result.error ?? "no failing probe" },
        files: probe && script ? { ...files, [probe]: script } : files });
    }
    case "plan": {
      const plan = result.artefacts["plan.md"];
      if (!plan) throw new Error("plan produced no plan.md");
      return ctx.emit({ trail: trail.id, actor, type: "plan_completed", data: { plan: "plan.md" },
        files: { ...files, "plan.md": plan } });
    }
    case "patch": {
      const head = result.outputs.head;
      if (!head) throw new Error("patch produced no head commit");
      await ctx.journal.pinRevision(trail.id, trail.rev + 1, head);
      return ctx.emit({ trail: trail.id, actor, type: "patch_completed", data: { head, revision: trail.rev + 1 }, files });
    }
    case "review":
      ctx.log("review step finished", { trail: trail.short });
      return;
  }
}

function proofFlags(ctx: ServerContext, trail: Trail) {
  const area = ctx.policy.autonomy.areas.find((a) => a.name === trail.area);
  return { ui: (area?.ui.length ?? 0) > 0, userFacing: area?.user_facing ?? false };
}

async function runProof(ctx: ServerContext, deps: AgentDeps, payload: ProofPayload, attempt: number): Promise<void> {
  const trail = await ctx.trails.get(payload.trailId);
  if (!trail || trail.rev !== payload.rev || !trail.head) return;
  const started = Date.now();
  const record = (outcome: "ok" | "failed" | "unavailable", note?: string) => deps.usage?.record({
    idempotencyKey: `proof:${trail.id}:${trail.rev}:${attempt}`, kind: "proof", persona: personaFor("proof"), step: "proof",
    engine: deps.runner?.name ?? "none", trailId: trail.id, short: trail.short, tokens: null, costMicrousd: null,
    wallMs: Date.now() - started, outcome, billedTo: deps.runner?.name === "local" ? "local" : "unknown", ...(note ? { note } : {}),
  });
  try {
    await proofRun(ctx, deps, payload, attempt, trail);
  } catch (error) {
    const reason = redact(String(error), deps.secrets ?? [], 500);
    await record(error instanceof Unverified ? "unavailable" : "failed", reason);
    await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "agent_failed",
      data: { step: "proof", reason, retryable: false }, expectedBound: { rev: trail.rev, head: trail.head },
      files: { "proof/error.json": JSON.stringify({ reason, operationKey: payload.operationKey ?? null,
        reconciliationRequired: error instanceof ReconciliationRequired }) } });
    return;
  }
  await record("ok");
}

async function proofRun(ctx: ServerContext, deps: AgentDeps, payload: ProofPayload, attempt: number, trail: Trail): Promise<void> {
  const events = await ctx.trails.events(trail.id);
  const repro = [...events].reverse().find((e) => e.type === "repro_completed" && e.data.ok);
  const probe = repro?.type === "repro_completed" ? repro.data.probe : undefined;
  if (!probe) throw new Error("no repro probe recorded for this trail");
  const flags = proofFlags(ctx, trail);
  const script = await ctx.journal.readFile(trail.id, probe);
  if (!script) throw new Error(`repro probe ${probe} is missing from the journal`);
  const bundle = await withSandbox(deps, ctx, trail, attempt,
    `${payload.operationKey ?? `${trail.id}:${trail.rev}:proof`}:${attempt}`, async (runner, handle) => {
    await runner.writeFile(handle, probe, script);
    return deps.buildProof({
    runner, handle, trail, base: trail.base.sha, head: trail.head!, probe,
    prepareRevision: await deps.prepareProof?.(runner, handle, trail),
    evaluate: (items, t) => {
      const r = evaluateProof(items, t.risk, flags);
      return { passed: r.passed, missing: r.missing.map(String) };
    },
    });
  });
  const { digest } = await ctx.journal.pinProof(trail.id, trail.rev, bundle);
  await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "proof_completed",
    data: { bundle, digest }, files: { "proof/manifest.json": JSON.stringify(bundle, null, 2) } });
}

export function agentHandlers(ctx: ServerContext, deps: AgentDeps): HandlerSlice {
  ctx.jobs.register("agent_step", (payload, job) => runStep(ctx, deps, payload as StepPayload, job.attempt));
  ctx.jobs.register("proof", (payload, job) => runProof(ctx, deps, payload as ProofPayload, job.attempt));
  return {
    start_agent: async (effect, trail) => {
      await ctx.jobs.enqueue("agent_step", effect.key, {
        trailId: trail.id, rev: trail.rev, step: effect.step, operationKey: effect.key, ...(effect.note ? { note: effect.note } : {}),
      } satisfies StepPayload);
    },
    run_proof: async (effect, trail) => {
      await ctx.jobs.enqueue("proof", effect.key, { trailId: trail.id, rev: trail.rev, operationKey: effect.key } satisfies ProofPayload);
    },
    stop_agent: async (_effect, trail) => {
      // Steps check the trail revision before emitting, so a stale step's result is discarded.
      ctx.log("agent stop requested", { trail: trail.short });
    },
  };
}
