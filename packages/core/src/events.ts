// Trail events (facts) and effects (commands). design/01 §2.2 and §9.
// The state machine (lifecycle.ts, owned by the core lane) is: transition(trail, event, ctx) → { trail, effects }.
import { z } from "zod";
import {
  Actor, Checkpoint, Decision, IsoTime, LandingMode, LandingReceipt, ProofBundle, Risk, SCHEMA_VERSION, Sha, TriageResult, WatchConfig,
} from "./schemas.ts";

const e = <T extends string, S extends z.ZodRawShape>(type: T, data: S) =>
  z.object({ type: z.literal(type), data: z.object(data) });

export const TrailEventBody = z.discriminatedUnion("type", [
  e("trail_created", { signalId: z.string().uuid(), title: z.string(), baseRef: z.string(), baseSha: Sha }),
  e("new_signal", { signalId: z.string().uuid(), severity: z.number().min(0).max(4).optional() }),
  e("triage_completed", { result: TriageResult }),
  e("research_completed", { hypothesis: z.string() /* path in journal tree */ }),
  e("checkpoint_decided", { checkpoint: Checkpoint, decision: Decision }),
  e("repro_completed", { ok: z.boolean(), probe: z.string().optional(), reason: z.string().optional() }),
  e("plan_completed", { plan: z.string() }),
  e("patch_completed", { head: Sha, revision: z.number().int().positive() }),
  e("proof_completed", { bundle: ProofBundle, digest: z.string() }),
  e("land_requested", { modes: z.array(LandingMode).optional() }),
  e("landing_completed", { receipt: LandingReceipt }),
  e("landing_failed", { reason: z.string(), baseMoved: z.boolean().default(false) }),
  e("base_moved", { newSha: Sha, overlapsTouchedFiles: z.boolean() }),
  e("watch_started", { config: WatchConfig }),
  e("watch_completed", { outcome: z.literal("clean") }),
  e("probe_regressed_after_landing", { criterion: z.string(), evidence: z.string() }),
  e("rollback_completed", { receipt: LandingReceipt }),
  e("human_comment", { text: z.string().max(4000), isRequest: z.boolean().default(false) }),
  e("claimed_by_human", {}),
  e("human_revision", { head: Sha }),
  e("released_by_human", {}),
  e("parked", { reason: z.string() }),
  e("resumed", {}),
  e("killed", { reason: z.string() }),
  e("budget_exceeded", { summary: z.string() }),
  e("spend_requested", { purpose: z.string(), microusd: z.number().int().positive() }),
  e("spend_decided", { decision: Decision }),
  e("child_trail_finished", { child: z.string().uuid(), proofDigest: z.string() }),
  e("parent_trail_landed", { parent: z.string().uuid() }),
  e("intent_updated", { intent: z.string() }),
  e("agent_failed", { step: z.string(), reason: z.string(), retryable: z.boolean() }),
]);
export type TrailEventBody = z.infer<typeof TrailEventBody>;
export type TrailEventType = TrailEventBody["type"];

/** Envelope persisted as journal `events/<id>.json` and in the Postgres event_inbox. */
export const TrailEvent = z.intersection(
  z.object({
    schema: z.literal(SCHEMA_VERSION),
    id: z.string().uuid(),               // UUIDv7, time-sortable
    trail: z.string().uuid(),
    rev: z.number().int().positive(),
    at: IsoTime,
    actor: Actor,
    parent: z.string().uuid().optional(), // previous event id in this trail, for causal order
  }),
  TrailEventBody,
);
export type TrailEvent = z.infer<typeof TrailEvent>;

/** Commands the state machine asks the orchestrator to perform. Each must be idempotent under `key`. */
export const Effect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_triage"), key: z.string(), signalId: z.string().uuid() }),
  z.object({ type: z.literal("start_agent"), key: z.string(), step: z.enum(["research", "repro", "plan", "patch", "review"]), note: z.string().optional() }),
  z.object({ type: z.literal("run_proof"), key: z.string() }),
  z.object({ type: z.literal("request_checkpoint"), key: z.string(), checkpoint: Checkpoint, blocking: z.boolean() }),
  z.object({ type: z.literal("request_spend"), key: z.string(), purpose: z.string(), microusd: z.number().int() }),
  z.object({ type: z.literal("land"), key: z.string(), modes: z.array(LandingMode) }),
  z.object({ type: z.literal("rebase"), key: z.string(), onto: Sha }),
  z.object({ type: z.literal("start_watch"), key: z.string() }),
  z.object({ type: z.literal("rollback"), key: z.string(), criterion: z.string() }),
  z.object({ type: z.literal("register_regression_probe"), key: z.string() }),
  z.object({ type: z.literal("notify_inbox"), key: z.string(), reason: z.string(), severity: Risk.optional() }),
  z.object({ type: z.literal("stop_agent"), key: z.string(), releaseLease: z.boolean() }),
  z.object({ type: z.literal("merge_signal"), key: z.string(), signalId: z.string().uuid(), into: z.string().uuid() }),
  z.object({ type: z.literal("resume_dependents"), key: z.string() }),
  z.object({ type: z.literal("mute_fingerprint"), key: z.string(), fingerprint: z.string(), forS: z.number().int() }),
  /** Re-run intent/regression/story probes (intent_updated, new_signal while proving). */
  z.object({ type: z.literal("run_probes"), key: z.string(), probes: z.array(z.string()), reason: z.string() }),
  /** Post a system or agent reply on the trail (and its forge mirror). */
  z.object({ type: z.literal("reply_comment"), key: z.string(), text: z.string() }),
  /** Start an approved real-respondent voxq run (after spend_decided approve). */
  z.object({ type: z.literal("start_respondent_run"), key: z.string(), purpose: z.string(), microusd: z.number().int() }),
  /** Hand a finished child trail's proof to its parent agent as evidence. */
  z.object({ type: z.literal("deliver_child_evidence"), key: z.string(), child: z.string().uuid(), proofDigest: z.string() }),
]);
export type Effect = z.infer<typeof Effect>;

/** Policy inputs the state machine needs but must not compute itself (provided by @ephyra/policy). */
export type TransitionContext = {
  now: string;
  /** Whether each checkpoint blocks for a human in this trail's area (autonomy.md). Shadow mode ⇒ blocking. */
  blocking: Record<"A" | "B" | "C", boolean>;
  /** Landing modes configured for this area. */
  landingModes: LandingMode[];
  /** Policy says a proof bundle with these items is sufficient for `ready` (already computed). */
  proofSufficient?: boolean;
  /** Policy-computed C decision when C is advisory (auto-land path), absent when blocking. */
  autoDecisionC?: Decision;
};

export type TransitionResult =
  | { ok: true; trail: import("./schemas.ts").Trail; effects: Effect[] }
  | { ok: false; error: string };
