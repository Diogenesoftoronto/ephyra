// Advisory checkpoints are evaluated as durable jobs; human review remains a policy option.
import { createHash } from "node:crypto";
import {
  JudgementResponse, ProofBundle, ReconciliationRequired, proofDigest,
  type Checkpoint, type DecideBackend, type InboxItem, type JudgementRequest, type OperationLedger, type Trail,
} from "@ephyra/core";
import { redact } from "@ephyra/agent";
import { JournalConflict } from "@ephyra/journal";
import { areaFor, buildPolicyQuestion, checkpointMode, evaluateProof, interpretPolicyAnswer, untrustedJson } from "@ephyra/policy";
import { canonicalJson } from "../audit.ts";
import { InvalidTransition, StaleApproval } from "../http/app.ts";
import { humanHandlers, latestProofDigest } from "./human.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";

export type CheckpointDeps = {
  decide: DecideBackend | null;
  ledger: OperationLedger;
  secrets?: string[];
  timeoutMs?: number;
  /** A repeated revise verdict must not create an unbounded paid loop. */
  maxRevisions?: number;
  /** Includes refreshes caused by new comments; retained in the journal across worker restarts. */
  maxEvaluations?: number;
};
type Snapshot = NonNullable<Awaited<ReturnType<ServerContext["journal"]["read"]>>>;
type Payload = {
  trailId: string; checkpoint: Checkpoint; operationKey: string; eventId: string;
  bound: InboxItem["bound"]; policyDigest: string;
};
const states = { A: "hypothesised", B: "planned", C: "ready" } as const;
const paths = { A: "hypothesis.md", B: "plan.md", C: "proof/manifest.json" } as const;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const policyDigest = (ctx: ServerContext) => digest(JSON.parse(JSON.stringify(ctx.policy)));
const recordPath = (job: Payload) => `decisions/${job.checkpoint}/${digest(job.operationKey)}.json`;

function payloadFor(ctx: ServerContext, current: Snapshot, checkpoint: Checkpoint, key: string): Payload {
  return { trailId: current.trail.id, checkpoint, eventId: current.events.at(-1)!.id,
    operationKey: `checkpoint:${digest(key)}`, policyDigest: policyDigest(ctx),
    bound: { rev: current.trail.rev, ...(current.trail.head ? { head: current.trail.head } : {}),
      ...(latestProofDigest(current.trail, current.events)
        ? { proofDigest: latestProofDigest(current.trail, current.events)! } : {}),
    },
  };
}

function matches(ctx: ServerContext, current: Snapshot, job: Payload): boolean {
  const trail = current.trail;
  return trail.state === states[job.checkpoint] && trail.owner?.kind !== "human"
    && trail.rev === job.bound.rev && trail.head === job.bound.head
    && latestProofDigest(trail, current.events) === job.bound.proofDigest
    && current.events.at(-1)?.id === job.eventId && policyDigest(ctx) === job.policyDigest;
}

async function currentFor(ctx: ServerContext, job: Payload): Promise<Snapshot | null> {
  const current = await ctx.journal.read(job.trailId);
  return current && matches(ctx, current, job) ? current : null;
}

async function writeRecord(ctx: ServerContext, job: Payload, record: unknown): Promise<Snapshot | null> {
  const current = await currentFor(ctx, job);
  if (!current) return null;
  // An empty event list adds inspectable evidence without synthesizing an event or changing trail state.
  const head = await ctx.journal.append(job.trailId, current.head, current.trail, [], {
    [recordPath(job)]: JSON.stringify(record, null, 2),
    [`decisions/latest-${job.checkpoint}.json`]: JSON.stringify(record, null, 2),
  });
  return { ...current, head };
}

async function archiveSuperseded(ctx: ServerContext, job: Payload, record: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.journal.read(job.trailId);
    if (!current) return;
    try {
      await ctx.journal.append(job.trailId, current.head, current.trail, [], {
        [recordPath(job)]: JSON.stringify({ ...record, status: "superseded", bound: job.bound }, null, 2),
      });
      return;
    } catch (error) {
      if (!(error instanceof JournalConflict)) throw error;
    }
  }
  throw new Error("Superseded checkpoint evidence could not be saved");
}

async function reserveEvaluation(ctx: ServerContext, job: Payload, limit: number): Promise<"reserved" | "exhausted" | "stale"> {
  const path = `decisions/${job.checkpoint}/revision-${job.bound.rev}-attempts.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await currentFor(ctx, job);
    if (!current) return "stale";
    const bytes = await ctx.journal.readFile(job.trailId, path);
    const keys: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : [];
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) throw new Error("Invalid checkpoint attempts");
    if (keys.includes(job.operationKey)) return "reserved";
    if (keys.length >= limit) return "exhausted";
    try {
      await ctx.journal.append(job.trailId, current.head, current.trail, [], { [path]: JSON.stringify([...keys, job.operationKey]) });
      return "reserved";
    } catch (error) {
      if (!(error instanceof JournalConflict)) throw error;
    }
  }
  throw new Error("Checkpoint attempt could not be reserved");
}

async function halt(ctx: ServerContext, job: Payload, reason: string, record: Record<string, unknown> = {}): Promise<void> {
  const current = await writeRecord(ctx, job, { ...record, checkpoint: job.checkpoint, bound: job.bound, reason });
  if (!current) return archiveSuperseded(ctx, job, { ...record, reason });
  await ctx.emit({ trail: job.trailId, actor: { kind: "system", id: "checkpoint-evaluator" },
    type: "parked", data: { reason }, expectedBound: job.bound, expectedJournalHead: current.head });
  await ctx.inbox.put({
    id: `${job.trailId}:notice`, trailId: job.trailId, short: current.trail.short, title: current.trail.title,
    area: current.trail.area, risk: current.trail.risk, severity: current.trail.severity,
    state: "parked", kind: "parked", blocking: false, bound: job.bound,
    artefact: { path: recordPath(job), summary: reason }, createdAt: ctx.clock.now().toISOString(),
  });
}

async function evidenceFor(ctx: ServerContext, current: Snapshot, checkpoint: Checkpoint, secrets: string[]) {
  const documents: Record<string, string> = {};
  for (const path of ["hypothesis.md", ...(checkpoint === "A" ? [] : ["plan.md"])]) {
    const bytes = await ctx.journal.readFile(current.trail.id, path);
    if (!bytes?.length || bytes.length > 64_000) return null;
    documents[path] = redact(new TextDecoder().decode(bytes), secrets, 64_000);
  }
  const area = ctx.policy.autonomy.areas.find((item) => item.name === current.trail.area);
  if (!area || checkpointMode(ctx.policy.autonomy, area, checkpoint) === "blocking") return null;
  let proof: ProofBundle | null = null;
  if (checkpoint === "C") {
    const bytes = await ctx.journal.readFile(current.trail.id, paths.C);
    if (!bytes?.length || bytes.length > 200_000) return null;
    const parsed = ProofBundle.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) return null;
    proof = parsed.data;
    const trail = current.trail;
    if (proof.trail !== trail.id || proof.rev !== trail.rev || proof.head !== trail.head || proof.base !== trail.base.sha
      || proof.risk !== trail.risk || !proof.passed || proof.missing.length
      || proofDigest(proof) !== latestProofDigest(trail, current.events)) return null;
    if (!evaluateProof(proof.items, trail.risk, { ui: area.ui.length > 0, userFacing: area.user_facing }).passed) return null;
    const scope = proof.items.find((item) => item.kind === "diff_scope");
    // The signal's assigned area cannot authorize a patch that expanded into a different policy area.
    if (!scope?.paths.length || scope.paths.some((path) => areaFor(ctx.policy.autonomy, [path]).name !== area.name)) return null;
  }
  const scope = proof?.items.find((item) => item.kind === "diff_scope") ?? null;
  const request = buildPolicyQuestion({ ...area, prose: redact(area.prose, secrets, 64_000) }, checkpoint, {
    diff_scope: scope, proof, exportedTypesChanged: scope?.exportedTypesChanged ?? null,
  });
  const state = request.state as Record<string, string>;
  state.documents = untrustedJson("checkpoint_documents", documents);
  state.comments = untrustedJson("checkpoint_comments", current.events.filter((event) => event.type === "human_comment")
    .slice(-8).map((event) => ({ event: event.id, author: event.actor.id, text: redact(event.data.text, secrets, 4000) })));
  state.trail = untrustedJson("trail", {
    title: redact(current.trail.title, secrets, 2000), area: area.name, risk: current.trail.risk,
    revision: current.trail.rev, base: current.trail.base, head: current.trail.head ?? null,
  });
  // Scrub serialized proof logs as well as prose before the provider call or journal write.
  for (const key of Object.keys(state)) state[key] = redact(state[key]!, secrets, 250_000);
  return { request, area };
}

function validAnswer(response: JudgementResponse): boolean {
  const answer = response.answers.verdict;
  return !response.fallback && answer?.type === "choice" && Number.isFinite(answer.confidence)
    && answer.confidence >= 0 && answer.confidence <= 1
    && (answer.probabilities[answer.choice] ?? 0) > 0
    && Object.values(answer.probabilities).every((p) => Number.isFinite(p) && p >= 0 && p <= 1);
}

async function evaluate(ctx: ServerContext, deps: CheckpointDeps, job: Payload): Promise<void> {
  const current = await currentFor(ctx, job);
  if (!current) return;
  if (!deps.decide?.supports.includes("choice")) {
    return halt(ctx, job, `Connect a decision model supporting choice questions to continue checkpoint ${job.checkpoint}.`,
      { status: "unavailable" });
  }
  const revisions = current.events.filter((event) => event.type === "checkpoint_decided"
    && event.data.checkpoint === job.checkpoint && event.data.decision.by === "policy"
    && event.data.decision.verdict === "revise").length;
  if (revisions >= (deps.maxRevisions ?? 3)) {
    return halt(ctx, job, `Checkpoint ${job.checkpoint} keeps requesting revisions. Add new evidence or change the approach before resuming.`,
      { status: "revision_limit", revisions });
  }
  let evidence;
  try { evidence = await evidenceFor(ctx, current, job.checkpoint, deps.secrets ?? []); }
  catch { evidence = null; }
  if (!evidence) {
    return halt(ctx, job, `Checkpoint ${job.checkpoint} needs complete evidence for the current revision and policy area.`,
      { status: "unavailable" });
  }
  const request: JudgementRequest = evidence.request;
  const planDigest = digest({ request, bound: job.bound, policyDigest: job.policyDigest });
  if (!(await writeRecord(ctx, job, { status: "evaluating", request, bound: job.bound, operationKey: job.operationKey }))) return;
  const reservation = await reserveEvaluation(ctx, job, deps.maxEvaluations ?? 3);
  if (reservation === "stale") return;
  if (reservation === "exhausted") {
    return halt(ctx, job, `Checkpoint ${job.checkpoint} reached its evaluation limit for this revision. Resolve the open question before resuming.`,
      { status: "evaluation_limit", operationKey: job.operationKey, request });
  }
  const claim = await deps.ledger.begin(job.operationKey, planDigest);
  let response: JudgementResponse;
  let answeredAt: string;
  if (!claim.fresh) {
    if (claim.record.status !== "done") {
      return halt(ctx, job, "The decision request has an uncertain outcome. Reconcile its operation before starting another request.",
        { status: "reconciliation_required", operationKey: job.operationKey, request });
    }
    const saved = claim.record.result as { response: unknown; answeredAt: string };
    response = JudgementResponse.parse(saved.response);
    answeredAt = saved.answeredAt;
  } else {
    try {
      response = JudgementResponse.parse(await deps.decide.decide(request, {
        idempotencyKey: job.operationKey, signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      }));
      // Unknown model identities are recorded exactly. A response containing secrets must never be retained.
      const encoded = JSON.stringify(response);
      if (redact(encoded, deps.secrets ?? [], 250_000) !== encoded) throw new Error("unsafe model response");
      answeredAt = ctx.clock.now().toISOString();
      await deps.ledger.complete(job.operationKey, { response, answeredAt });
    } catch {
      // Even a timeout may have charged upstream. The ledger prevents the queue from blindly resending it.
      const note = "The decision request could not be confirmed. Reconcile its operation before resuming.";
      try { await deps.ledger.markAmbiguous(job.operationKey, note); }
      catch { /* A complete response may already be durable; a later retry reads the receipt. */ }
      await halt(ctx, job, note, { status: "reconciliation_required", operationKey: job.operationKey, request });
      return;
    }
  }
  const decision = validAnswer(response) ? interpretPolicyAnswer(response, ctx.policy.thresholds, {
    at: answeredAt, shadow: false, area: evidence.area, checkpoint: job.checkpoint,
  }) : null;
  const record = { status: decision ? "decided" : "unresolved", operationKey: job.operationKey,
    request, response, answeredAt, bound: job.bound, decision };
  if (!decision) {
    const known = Object.hasOwn(ctx.policy.thresholds, response.model);
    return halt(ctx, job, known
      ? `Checkpoint ${job.checkpoint} could not reach a calibrated decision. Add evidence or select an explicitly configured reviewer.`
      : "The decision model has no calibrated thresholds. Configure thresholds for the recorded model identity, then resume.", record);
  }
  const recorded = await writeRecord(ctx, job, record);
  if (!recorded) return archiveSuperseded(ctx, job, record);
  try {
    await ctx.emit({ trail: job.trailId, actor: { kind: "policy", id: response.model }, type: "checkpoint_decided",
      data: { checkpoint: job.checkpoint, decision }, expectedBound: job.bound, expectedJournalHead: recorded.head });
  } catch (error) {
    if (!(error instanceof StaleApproval || error instanceof InvalidTransition)) throw error;
    await archiveSuperseded(ctx, job, record);
    return;
  }
  await ctx.inbox.remove(`${job.trailId}:${job.checkpoint}`);
}

async function refreshAfterComment(ctx: ServerContext, deps: CheckpointDeps, job: Payload): Promise<void> {
  const current = await ctx.journal.read(job.trailId);
  const event = current?.events.at(-1);
  if (!current || current.trail.state !== states[job.checkpoint] || current.trail.owner?.kind === "human"
    || current.trail.rev !== job.bound.rev || current.trail.head !== job.bound.head
    || event?.id === job.eventId || event?.type !== "human_comment") return;
  const key = `checkpoint-refresh:${job.trailId}:${job.checkpoint}:${job.bound.rev}:${event.id}`;
  const refreshed = payloadFor(ctx, current, job.checkpoint, key);
  const previous = await deps.ledger.get(job.operationKey);
  if (previous && previous.status !== "done") {
    return halt(ctx, refreshed, "The previous decision request has an uncertain outcome. Reconcile it before evaluating the new evidence.",
      { status: "reconciliation_required", operationKey: job.operationKey });
  }
  await ctx.jobs.enqueue("checkpoint_evaluation", key, refreshed);
}

/** Spread after humanHandlers so supervised requests retain the existing review flow. */
export function checkpointHandlers(ctx: ServerContext, deps: CheckpointDeps): HandlerSlice {
  const humans = humanHandlers(ctx);
  ctx.jobs.register("checkpoint_evaluation", async (payload) => {
    const job = payload as Payload;
    try { await evaluate(ctx, deps, job); }
    catch (error) {
      if (error instanceof StaleApproval || error instanceof InvalidTransition) return;
      // Storage failures may retry this job; the operation ledger still forbids repeating provider calls.
      if (error instanceof ReconciliationRequired) throw error;
      throw new Error("Checkpoint evidence could not be saved; the provider operation must be reconciled before any retry.");
    }
    finally { await refreshAfterComment(ctx, deps, job); }
  });
  return {
    request_checkpoint: async (effect, trail: Trail) => {
      if (effect.blocking) return humans.request_checkpoint!(effect, trail);
      const current = await ctx.journal.read(trail.id);
      if (!current || current.trail.state !== states[effect.checkpoint] || current.trail.owner?.kind === "human") return;
      const payload = payloadFor(ctx, current, effect.checkpoint, effect.key);
      await ctx.jobs.enqueue("checkpoint_evaluation", effect.key, payload);
    },
  };
}
