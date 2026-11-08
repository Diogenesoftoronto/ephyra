import type { AgentStep, Trail, TrailEvent } from "@ephyra/core";
import { redact } from "@ephyra/agent";
import { untrustedJson } from "@ephyra/policy";

export type RecoveryStrategy = "initial" | "alternate_hypothesis" | "additional_evidence" | "fresh_context";
export type RecoveryOptions = {
  retrySafety?: "read_only" | "isolated" | "unknown" | "ambiguous_external";
  /** Only a real executor capability may enable this strategy. */
  canResetContext?: boolean;
  maxAttempts?: number;
  secrets?: string[];
};

const checkpointFor = { research: "A", plan: "B", patch: "C" } as const;
const instructions: Record<RecoveryStrategy, string> = {
  initial: "Investigate the recorded evidence and test a falsifiable causal hypothesis. Record what would disconfirm it.",
  alternate_hypothesis: "The prior approach failed. Test a materially different causal hypothesis and seek disconfirming evidence. "
    + "Do not repeat the same commands or patch without a new observation that explains why the outcome should change.",
  additional_evidence: "Stop repeating the prior approach. Gather an independent observation from available logs, telemetry, "
    + "a different probe, or an authorized evidence source. Compare at least two explanations before choosing the next action.",
  fresh_context: "Use the executor's supported fresh context with the durable recovery handoff. Preserve failed hypotheses, "
    + "operation receipts, evidence references and the remaining budget. Seek a different explanation before attempting another fix.",
};
const unblock = " If the available tools cannot resolve the uncertainty, record one targeted unblock question, the person or role "
  + "with the missing information, why their answer changes the next action, and the evidence already checked. "
  + "Do not contact anyone or widen permissions from this instruction alone.";

/** Pure recovery planning. Provider/sandbox reset and external reconciliation must be performed by their owning adapters. */
export function buildRecovery(trail: Trail, events: TrailEvent[], step: AgentStep, options: RecoveryOptions = {}) {
  const seen = new Set<string>();
  const relevant = events.filter((event) => {
    if (event.trail !== trail.id || event.rev !== trail.rev || seen.has(event.id)) return false;
    seen.add(event.id);
    return (event.type === "agent_failed" && event.data.step === step)
      || (event.type === "checkpoint_decided" && event.data.decision.verdict === "revise"
        && event.data.checkpoint === checkpointFor[step as keyof typeof checkpointFor])
      || (step === "patch" && event.type === "proof_completed" && !event.data.bundle.passed);
  });
  const failures = relevant.filter((event) => event.type === "agent_failed");
  const revisions = relevant.filter((event) => event.type === "checkpoint_decided");
  const proofs = relevant.filter((event) => event.type === "proof_completed");
  // Core's proof counter spans patch revisions; counting only same-revision events would reset recovery on every new patch.
  const proofAttempts = step === "patch" ? Math.max(trail.attempts.proof, proofs.length) : 0;
  const previousAttempts = failures.length + revisions.length + proofAttempts;
  const attempt = previousAttempts + 1;
  const limit = Number.isInteger(options.maxAttempts) ? Math.min(10, Math.max(1, options.maxAttempts!)) : 3;
  const safety = options.retrySafety ?? "unknown";
  const unsafe = safety === "ambiguous_external" || (previousAttempts > 0 && safety === "unknown")
    || failures.some((event) => event.type === "agent_failed" && !event.data.retryable);
  const budgetExhausted = trail.budget.tokensUsed >= trail.budget.tokensMax
    || trail.budget.spendMicrousdUsed > trail.budget.spendMicrousdMax;
  const exhausted = unsafe || budgetExhausted || attempt > limit;
  const strategy: RecoveryStrategy = attempt === 1 ? "initial" : attempt === 2 ? "alternate_hypothesis"
    : options.canResetContext === true ? "fresh_context" : "additional_evidence";
  const reason = safety === "ambiguous_external" ? "Reconcile the uncertain external operation before any retry."
    : unsafe ? "A safe retry has not been established for the previous failure."
      : budgetExhausted ? "The trail's existing budget is exhausted."
        : attempt > limit ? "Recovery attempts are exhausted; a new observation or explicit disposition is required."
          : null;
  const history = relevant.slice(-12).map((event) => ({
    event: event.id, revision: event.rev, type: event.type,
    observation: redact(event.type === "agent_failed" ? event.data.reason
      : event.type === "checkpoint_decided" ? event.data.decision.note ?? "Reviewer requested a different approach."
        : event.type === "proof_completed" ? `Missing proof: ${event.data.bundle.missing.join(", ")}` : "",
    options.secrets ?? [], 512),
  }));
  const signatures = failures.map((event) => event.type === "agent_failed" ? event.data.reason.trim().replace(/\s+/g, " ").toLowerCase() : "");
  const repeatedFailure = new Set(signatures.filter(Boolean)).size < signatures.filter(Boolean).length;
  const artifact = {
    schema: 1, trail: trail.id, rev: trail.rev, step, attempt, maxAttempts: limit, strategy, exhausted, reason,
    retrySafety: safety, contextResetSupported: options.canResetContext === true,
    repeatedFailure, counts: { failures: failures.length, revisions: revisions.length, proofs: proofAttempts },
    budget: { ...trail.budget }, remainingTokens: Math.max(0, trail.budget.tokensMax - trail.budget.tokensUsed),
    sourceEvents: relevant.map((event) => event.id), history, omittedFromContext: Math.max(0, relevant.length - history.length),
  };
  return {
    attempt, exhausted, strategy,
    instruction: (reason ?? instructions[strategy]) + unblock,
    untrustedHistory: untrustedJson("recovery_history", artifact),
    artifact,
  };
}
