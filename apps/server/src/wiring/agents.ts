// Agent steps and proof. Each runs as a job: allocate a sandbox at the trail's current commit, run one
// step with the coding agent, write artefacts into the journal, emit the next event, destroy the sandbox.
// No sandbox is kept alive while a trail waits on a human.
import { evaluateProofBeforeC } from "@ephyra/policy";
import { ReconciliationRequired, Unverified, personaFor, sha256Hex } from "@ephyra/core";
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
import { WorkControl } from "./control.ts";
import { recordTrailUsage, workBudget } from "./budget.ts";

export type BuildProofFn = (options: {
  runner: Runner; handle: RunnerHandle; trail: Trail; base: string; head: string; probe: string;
  evaluate: (items: ProofItem[], trail: Trail) => { passed: boolean; missing: string[]; awaitingHumanC?: boolean };
  prepareRevision?: ProofOptions["prepareRevision"];
  collectEvidence?: ProofOptions["collectEvidence"];
  secrets?: string[]; deadlineMs?: number;
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
  control?: WorkControl;
  canInvestigate?: () => Promise<boolean>;
  createProofCollector?: (trail: Trail, options: {
    signal: AbortSignal; onUsage: NonNullable<import("@ephyra/agent").AgentRunOptions["onUsage"]>;
  }) => ProofOptions["collectEvidence"];
};

type StepPayload = { trailId: string; rev: number; step: AgentStep; note?: string; operationKey?: string; generation?: number };
type ProofPayload = { trailId: string; rev: number; operationKey?: string; generation?: number };

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
  const indexBytes = await ctx.journal.readFile(trail.id, "evidence/children/index.json");
  if (indexBytes) {
    const entries: unknown = JSON.parse(decoder.decode(indexBytes));
    if (!Array.isArray(entries) || entries.length > 100) throw new Unverified("bounded child evidence index");
    let remaining = 40_000;
    for (const entry of entries.slice(-5)) {
      if (!entry || typeof entry.path !== "string" || !/^evidence\/children\/[a-f0-9-]{36}-\d+\.json$/.test(entry.path))
        throw new Unverified("child evidence path");
      const bytes = await ctx.journal.readFile(trail.id, entry.path);
      if (bytes && remaining > 0) {
        const content = decoder.decode(bytes).slice(0, remaining);
        out[`child_evidence_${Object.keys(out).length}`] = content;
        remaining -= content.length;
      }
    }
  }
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
  work: (runner: Runner, handle: RunnerHandle, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!deps.runner) throw new Error("no runner configured on this deployment");
  return (deps.control ?? new WorkControl()).run(trail.id, deps.runner, async (runner, signal) => {
    if (!await ownsWork(ctx, trail)) throw new Unverified("superseded agent allocation");
    if (deps.canInvestigate && !await deps.canInvestigate()) throw new Unverified("workspace investigation readiness");
    signal.throwIfAborted();
    const handle = await runner.allocate({
      trail, attempt, repoUrl: ctx.repo.url, commit: commitFor(trail), profile: deps.profile,
      leaseS: Math.ceil(workBudget(trail, deps.stepTimeoutS).wallclockS) + 300, operationKey,
    });
    try {
      if (!await ownsWork(ctx, trail)) throw new Unverified("superseded sandbox work");
      if (deps.canInvestigate && !await deps.canInvestigate()) throw new Unverified("workspace investigation readiness");
      signal.throwIfAborted();
      return await work(runner, handle, signal);
    } finally {
      try { await runner.destroy(handle); }
      catch { throw new ReconciliationRequired(operationKey, "Sandbox destruction needs reconciliation."); }
    }
  });
}

const stepState: Record<AgentStep, Trail["state"]> = {
  research: "researching", repro: "reproducing", plan: "reproducing", patch: "patching", review: "proving",
};
function workBound(trail: Trail) {
  return { rev: trail.rev, head: trail.head, base: trail.base.sha, state: trail.state,
    policyCommit: trail.policyCommit, generation: trail.workGeneration };
}
async function ownsWork(ctx: ServerContext, trail: Trail): Promise<boolean> {
  const current = await ctx.trails.get(trail.id);
  return Boolean(current && current.rev === trail.rev && current.head === trail.head
    && current.base.sha === trail.base.sha && current.state === trail.state && current.policyCommit === trail.policyCommit
    && current.workGeneration === trail.workGeneration);
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
  await ctx.refreshPolicy?.();
  const trail = await ctx.trails.get(payload.trailId);
  if (!trail || trail.rev !== payload.rev || trail.state !== stepState[payload.step]
    || (trail.workGeneration ?? 0) !== (payload.generation ?? 0)) return;
  if (deps.canInvestigate && !await deps.canInvestigate()) {
    await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "bootstrap" }, type: "parked",
      data: { reason: "Workspace setup needs verification before autonomous investigation can continue." }, expectedWork: workBound(trail) });
    return;
  }
  const actor = { kind: "agent" as const, id: deps.agent?.name ?? "none" };
  const started = Date.now();
  const budget = workBudget(trail, deps.stepTimeoutS);
  if (budget.reason) {
    await ctx.emit({ trail: trail.id, actor, type: "budget_exceeded", data: { summary: budget.reason }, expectedWork: workBound(trail) });
    return;
  }
  const operation = `${payload.operationKey ?? `${trail.id}:${trail.rev}:${payload.step}`}:${attempt}`;
  const identity = sha256Hex(operation).slice(0, 24);
  let usageReported = false;
  let agentDispatched = false;
  const onUsage: NonNullable<import("@ephyra/agent").AgentRunOptions["onUsage"]> = async (usage) => {
    await recordTrailUsage(ctx, trail.id, usage.key, { tokens: usage.tokens, costMicrousd: usage.costMicrousd, wallMs: 0 });
    usageReported = true;
  };
  const record = (outcome: "ok" | "failed" | "unavailable", extra: { engine?: string; tokens?: number | null; cost?: number | null; note?: string }) =>
    deps.usage?.record({
      idempotencyKey: `agent_step:${trail.id}:${identity}`, kind: "agent_step", persona: personaFor(payload.step),
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
    budget: { tokens: budget.tokens, wallclockS: budget.wallclockS,
      ...(budget.spendMicrousd !== undefined ? { spendMicrousd: budget.spendMicrousd } : {}) },
  };
  let result;
  const agent = deps.agent;
  const run: RunHandle | undefined = await deps.runs?.start({
    id: `${trail.id}.${trail.rev}.${payload.step}.${identity}`, trailId: trail.id, short: trail.short, step: payload.step,
    persona: personaFor(payload.step), engine: engineOf(agent), executor: executorFor(agent, deps.runner),
  });
  try {
    result = await withSandbox(deps, ctx, trail, attempt,
      operation, async (runner, handle, signal) => {
      if (run && executorFor(agent, runner).kind !== "local") run.executor({ id: handle.id });
      agentDispatched = true;
      const r = await runAgent(agent, task, runner, handle, {
        signal, onUsage, ...(run ? { onEvent: run.event, onExecutor: run.executor } : {}),
        ...(deps.secrets ? { secrets: deps.secrets } : {}),
      });
      if (!usageReported) await onUsage({ key: `${operation}:result`, ...r.usage });
      signal.throwIfAborted();
      if (!await ownsWork(ctx, trail)) throw new Unverified("superseded agent output");
      if (deps.canInvestigate && !await deps.canInvestigate()) throw new Unverified("workspace investigation readiness changed");
      if (r.ok && payload.step === "patch" && r.outputs.head) await publishHead(runner, handle, ctx, trail, r.outputs.head);
      return r;
    });
  } catch (error) {
    if (!usageReported && agentDispatched)
      await onUsage({ key: `${operation}:unavailable`, tokens: null, costMicrousd: null, model: agent.name });
    await recordTrailUsage(ctx, trail.id, `${operation}:wallclock`, { tokens: 0, costMicrousd: 0, wallMs: Date.now() - started });
    // Output we could not verify (Unverified) is unavailable evidence, not an observed failure.
    await record(error instanceof Unverified ? "unavailable" : "failed", { note: String(error) });
    await run?.finish({ status: error instanceof Unverified ? "unavailable" : "failed", error: String(error) });
    if (!await ownsWork(ctx, trail)) return;
    await ctx.emit({ trail: trail.id, actor, type: "agent_failed", expectedWork: workBound(trail),
      data: { step: payload.step, reason: redact(String(error), deps.secrets ?? [], 500),
        retryable: !(error instanceof ReconciliationRequired) && recovery.attempt < 3 && recovery.artifact.retrySafety === "isolated" },
      files: { ...evidence.files, ...recoveryFiles } });
    return;
  }
  await recordTrailUsage(ctx, trail.id, `${operation}:wallclock`, { tokens: 0, costMicrousd: 0, wallMs: Date.now() - started });
  if (!await ownsWork(ctx, trail)) {
    await record("unavailable", { engine: engineOf(agent, result.usage.model), tokens: result.usage.tokens,
      cost: result.usage.costMicrousd, note: "The code or workflow changed before the result could be accepted." });
    await run?.finish({ status: "unavailable", error: "The code or workflow changed before the result could be accepted." });
    return;
  }
  const spent = { engine: engineOf(deps.agent, result.usage.model), tokens: result.usage.tokens, cost: result.usage.costMicrousd };
  // A failed turn's artefacts are not successful step evidence (e.g. Amp reauthentication).
  if (!result.ok) {
    await record("failed", { ...spent, note: result.error ?? "coding agent returned an unsuccessful turn" });
    await run?.finish({ status: "failed", engine: spent.engine, usage: { tokens: spent.tokens, costMicrousd: spent.cost },
      error: result.error ?? "coding agent returned an unsuccessful turn" });
    await ctx.emit({ trail: trail.id, actor, type: "agent_failed", expectedWork: workBound(trail),
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
      return ctx.emit({ trail: trail.id, actor, type: "research_completed", expectedWork: workBound(trail), data: { hypothesis: "hypothesis.md" },
        files: { ...files, "hypothesis.md": hypothesis } });
    }
    case "repro": {
      const probe = result.outputs.probe;
      const script = probe ? result.artefacts[probe] : undefined;
      if (probe && !script) throw new Error("repro reported a probe but returned no probe content");
      // The probe is kept in the journal: the sandbox that wrote it is destroyed after this step.
      return ctx.emit({ trail: trail.id, actor, type: "repro_completed", expectedWork: workBound(trail),
        data: probe ? { ok: true, probe } : { ok: false, reason: result.error ?? "no failing probe" },
        files: probe && script ? { ...files, [probe]: script } : files });
    }
    case "plan": {
      const plan = result.artefacts["plan.md"];
      if (!plan) throw new Error("plan produced no plan.md");
      return ctx.emit({ trail: trail.id, actor, type: "plan_completed", expectedWork: workBound(trail), data: { plan: "plan.md" },
        files: { ...files, "plan.md": plan } });
    }
    case "patch": {
      const head = result.outputs.head;
      if (!head) throw new Error("patch produced no head commit");
      await ctx.journal.pinRevision(trail.id, trail.rev + 1, head);
      return ctx.emit({ trail: trail.id, actor, type: "patch_completed", expectedWork: workBound(trail),
        data: { head, revision: trail.rev + 1 }, files });
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
  await ctx.refreshPolicy?.();
  const trail = await ctx.trails.get(payload.trailId);
  if (!trail || trail.rev !== payload.rev || !trail.head || (trail.workGeneration ?? 0) !== (payload.generation ?? 0)
    || !(trail.state === "proving" || trail.state === "handed_off" && trail.resumeTo === "proving")) return;
  if (deps.canInvestigate && !await deps.canInvestigate()) {
    if (trail.state !== "handed_off") await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "bootstrap" }, type: "parked",
      data: { reason: "Workspace setup needs verification before proof execution can continue." }, expectedWork: workBound(trail) });
    return;
  }
  const budget = workBudget(trail, deps.stepTimeoutS);
  if (budget.reason) {
    if (trail.state !== "handed_off") await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" },
      type: "budget_exceeded", data: { summary: budget.reason }, expectedWork: workBound(trail) });
    else await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "agent_failed",
      data: { step: "proof", reason: budget.reason, retryable: false }, expectedWork: workBound(trail) });
    return;
  }
  const started = Date.now();
  const record = (outcome: "ok" | "failed" | "unavailable", note?: string) => deps.usage?.record({
    idempotencyKey: `proof:${trail.id}:${sha256Hex(payload.operationKey ?? `${trail.rev}:${attempt}`).slice(0, 24)}`,
    kind: "proof", persona: personaFor("proof"), step: "proof",
    engine: deps.runner?.name ?? "none", trailId: trail.id, short: trail.short, tokens: null, costMicrousd: null,
    wallMs: Date.now() - started, outcome, billedTo: deps.runner?.name === "local" ? "local" : "unknown", ...(note ? { note } : {}),
  });
  try {
    await proofRun(ctx, deps, payload, attempt, trail);
  } catch (error) {
    const reason = redact(String(error), deps.secrets ?? [], 500);
    await record(error instanceof Unverified ? "unavailable" : "failed", reason);
    if (!await ownsWork(ctx, trail)) return;
    await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "agent_failed",
      data: { step: "proof", reason, retryable: false }, expectedWork: workBound(trail),
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
  const started = Date.now();
  const operation = `${payload.operationKey ?? `${trail.id}:${trail.rev}:proof`}:${attempt}`;
  const bundle = await withSandbox(deps, ctx, trail, attempt,
    `${payload.operationKey ?? `${trail.id}:${trail.rev}:proof`}:${attempt}`, async (runner, handle, signal) => {
    await runner.writeFile(handle, probe, script);
    return deps.buildProof({
    runner, handle, trail, base: trail.base.sha, head: trail.head!, probe,
    secrets: deps.secrets, deadlineMs: workBudget(trail, deps.stepTimeoutS).wallclockS * 1000,
    prepareRevision: await deps.prepareProof?.(runner, handle, trail),
    collectEvidence: deps.createProofCollector?.(trail, { signal, onUsage: async (usage) => {
      await recordTrailUsage(ctx, trail.id, usage.key, { tokens: usage.tokens, costMicrousd: usage.costMicrousd, wallMs: 0 });
      signal.throwIfAborted();
    } }),
    evaluate: (items, t) => {
      const r = evaluateProofBeforeC(items, t.risk, flags);
      return { ...r, missing: r.missing.map(String) };
    },
    });
  }).finally(() => recordTrailUsage(ctx, trail.id, `${operation}:wallclock`, {
    tokens: 0, costMicrousd: 0, wallMs: Date.now() - started,
  }));
  if (!await ownsWork(ctx, trail)) return;
  // Missing integrations are not a request to regenerate the patch with the same absent evidence.
  const unavailable = bundle.missing.filter((kind) => !bundle.items.some((item) => item.kind === kind));
  if (unavailable.length && trail.state !== "handed_off") {
    await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "parked",
      data: { reason: `Required proof evidence is unavailable: ${unavailable.join(", ")}` }, expectedWork: workBound(trail),
      files: { "proof/incomplete.json": JSON.stringify(bundle, null, 2) } });
    return;
  }
  const { digest } = await ctx.journal.pinProof(trail.id, trail.rev, bundle);
  await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "proof" }, type: "proof_completed",
    data: { bundle, digest }, expectedWork: workBound(trail), files: { "proof/manifest.json": JSON.stringify(bundle, null, 2) } });
}

export function agentHandlers(ctx: ServerContext, deps: AgentDeps): HandlerSlice {
  deps = { ...deps, control: deps.control ?? new WorkControl() };
  ctx.jobs.register("agent_step", (payload, job) => runStep(ctx, deps, payload as StepPayload, job.attempt));
  ctx.jobs.register("proof", (payload, job) => runProof(ctx, deps, payload as ProofPayload, job.attempt));
  return {
    start_agent: async (effect, trail) => {
      await ctx.jobs.enqueue("agent_step", effect.key, {
        trailId: trail.id, rev: trail.rev, step: effect.step, operationKey: effect.key, generation: trail.workGeneration ?? 0,
        ...(effect.note ? { note: effect.note } : {}),
      } satisfies StepPayload);
    },
    run_proof: async (effect, trail) => {
      await ctx.jobs.enqueue("proof", effect.key, { trailId: trail.id, rev: trail.rev, operationKey: effect.key,
        generation: trail.workGeneration ?? 0 } satisfies ProofPayload);
    },
    stop_agent: async (effect, trail) => {
      const receipts = await deps.control!.stop(trail.id);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await ctx.journal.read(trail.id);
        if (!current) throw new Error("Stopped trail journal is missing");
        const path = `operations/stop-${effect.key.replace(/[^a-zA-Z0-9-]/g, "_").slice(-180)}.json`;
        try {
          await ctx.journal.append(trail.id, current.head, current.trail, [], { [path]: JSON.stringify({ receipts }) });
          break;
        } catch (error) { if (attempt === 2) throw error; }
      }
      if (receipts.some((receipt) => receipt.status === "reconciliation_required"))
        throw new ReconciliationRequired(effect.key, "Runner teardown needs reconciliation; inspect the stop receipt.");
    },
  };
}
