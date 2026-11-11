// The loop view-model: everything the console needs to show a quest as a position in the self-driving loop.
// Pure functions over core shapes. No React, no fetch, no clock. design/09-console-redesign.md explains the choices.
import {
  budgetBlocker, personaFor, type AgentRun, type Budget, type Effect, type InvestigationQuestion, type LandingMode, type PersonaId,
  type Risk, type Trail, type TrailEvent, type TrailState,
} from "@ephyra/core";
import { z } from "zod";

// ───────────────────────── Stages ─────────────────────────

export const STAGE_IDS = ["signal", "evidence", "hypothesis", "repro", "patch", "proof", "landing", "watch"] as const;
export type StageId = (typeof STAGE_IDS)[number];
export type Gate = "A" | "B" | "C";

export type Stage = {
  id: StageId;
  index: number;
  label: string;
  /** What Ephyra is doing while a quest is here, in plain words. */
  doing: string;
  persona: PersonaId;
  /** 0 is the production surface, 1 is the git seabed. The loop sinks, then rises. */
  depth: number;
  /** The checkpoint decided while a quest sits in this stage. */
  gate?: Gate;
};

export const LOOP_STAGES: readonly Stage[] = [
  { id: "signal", index: 0, label: "Signal", doing: "Listening to production", persona: "rho", depth: 0 },
  { id: "evidence", index: 1, label: "Evidence", doing: "Gathering evidence", persona: "bell", depth: 1 / 3 },
  { id: "hypothesis", index: 2, label: "Hypothesis", doing: "Weighing the hypothesis", persona: "bell", depth: 2 / 3, gate: "A" },
  { id: "repro", index: 3, label: "Repro", doing: "Reproducing the failure", persona: "nema", depth: 1 },
  { id: "patch", index: 4, label: "Patch", doing: "Writing the fix", persona: "lappet", depth: 1, gate: "B" },
  { id: "proof", index: 5, label: "Proof", doing: "Proving the fix", persona: "nema", depth: 2 / 3, gate: "C" },
  { id: "landing", index: 6, label: "Landing", doing: "Landing the change", persona: "turri", depth: 1 / 3 },
  { id: "watch", index: 7, label: "Watch", doing: "Watching production", persona: "turri", depth: 0 },
];

const STAGE_BY_ID = Object.fromEntries(LOOP_STAGES.map((stage) => [stage.id, stage])) as Record<StageId, Stage>;
export const stage = (id: StageId): Stage => STAGE_BY_ID[id];

/** Where each working state sits. Held states (`parked`, `handed_off`, `abandoned`) take the stage they would return to. */
const STATE_STAGE: Record<TrailState, StageId | null> = {
  sensed: "signal", triaged: "signal", researching: "evidence", hypothesised: "hypothesis", reproducing: "repro",
  planned: "patch", patching: "patch", proving: "proof", ready: "proof", landing: "landing", watching: "watch",
  closed: "watch", rolled_back: "watch", parked: null, handed_off: null, abandoned: null,
};
/** How far through its stage a state is, 0 to 1. Lets two states in one stage sit apart on a path. */
const STATE_WITHIN: Partial<Record<TrailState, number>> = {
  sensed: 0.25, triaged: 0.7, planned: 0.2, patching: 0.65, proving: 0.3, ready: 0.8, closed: 0.9, rolled_back: 0.4,
};

export function stageOf(trail: Pick<Trail, "state" | "resumeTo">): Stage {
  const id = STATE_STAGE[trail.state] ?? (trail.resumeTo ? STATE_STAGE[trail.resumeTo] : null) ?? "signal";
  return STAGE_BY_ID[id];
}

/** Position along the loop, 0 (signal just heard) to 1 (watched clean). */
export function progressOf(trail: Pick<Trail, "state" | "resumeTo">): number {
  const at = stageOf(trail);
  const state = STATE_STAGE[trail.state] ? trail.state : trail.resumeTo ?? trail.state;
  return (at.index + (STATE_WITHIN[state] ?? 0.5)) / LOOP_STAGES.length;
}

/** The loop as a path: x runs left to right with progress, depth follows the stages (surface, seabed, surface). */
export function loopPoint(progress: number): { x: number; depth: number } {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const scaled = p * LOOP_STAGES.length - 0.5;
  const lower = Math.min(LOOP_STAGES.length - 1, Math.max(0, Math.floor(scaled)));
  const upper = Math.min(LOOP_STAGES.length - 1, lower + 1);
  const mix = Math.min(1, Math.max(0, scaled - lower));
  const a = LOOP_STAGES[lower]!.depth;
  const b = LOOP_STAGES[upper]!.depth;
  return { x: p, depth: a + (b - a) * mix };
}

// ───────────────────────── Recovery attempts ─────────────────────────
// The server journals one artefact per agent attempt at `artefacts/recovery/<step>-<rev>-<attempt>.json`.

export const RecoveryStrategy = z.enum(["initial", "alternate_hypothesis", "additional_evidence", "fresh_context"]);
export type RecoveryStrategy = z.infer<typeof RecoveryStrategy>;

export const RecoveryArtifact = z.object({
  schema: z.literal(1),
  trail: z.string(),
  rev: z.number().int().positive(),
  step: z.string(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  strategy: RecoveryStrategy,
  exhausted: z.boolean(),
  reason: z.string().nullable(),
  retrySafety: z.enum(["read_only", "isolated", "unknown", "ambiguous_external"]).optional(),
  contextResetSupported: z.boolean().optional(),
  repeatedFailure: z.boolean().optional(),
  remainingTokens: z.number().nonnegative().optional(),
  history: z.array(z.object({ event: z.string(), revision: z.number(), type: z.string(), observation: z.string() })).default([]),
  omittedFromContext: z.number().int().nonnegative().optional(),
});
export type RecoveryArtifact = z.infer<typeof RecoveryArtifact>;

export const RECOVERY_PATH = /^artefacts\/recovery\/([a-z_]+)-(\d+)-(\d+)\.json$/;

export const STRATEGY_LABEL: Record<RecoveryStrategy, string> = {
  initial: "First approach",
  alternate_hypothesis: "Different hypothesis",
  additional_evidence: "New evidence",
  fresh_context: "Fresh context",
};
const STRATEGY_DOING: Record<RecoveryStrategy, string> = {
  initial: "Working the first approach",
  alternate_hypothesis: "Trying a different hypothesis",
  additional_evidence: "Gathering new evidence before trying again",
  fresh_context: "Starting over with a fresh context",
};
export const STRATEGY_MEANS: Record<RecoveryStrategy, string> = {
  initial: "Test one falsifiable cause and record what would disprove it.",
  alternate_hypothesis: "The last approach failed. Test a materially different cause; never repeat the same commands.",
  additional_evidence: "Stop repeating. Fetch an independent observation and compare at least two explanations.",
  fresh_context: "Drop the working context. Keep failed hypotheses, receipts and remaining budget in a handoff.",
};

/** Read recovery attempts out of journal files. Unreadable or mismatched files are skipped, never guessed at. */
export function parseRecovery(files: readonly { path: string; content: string | null }[]): RecoveryArtifact[] {
  const attempts: RecoveryArtifact[] = [];
  for (const file of files) {
    const match = RECOVERY_PATH.exec(file.path);
    if (!match || file.content === null) continue;
    let json: unknown;
    try { json = JSON.parse(file.content); } catch { continue; }
    const parsed = RecoveryArtifact.safeParse(json);
    if (!parsed.success) continue;
    const value = parsed.data;
    if (value.step !== match[1] || value.rev !== Number(match[2]) || value.attempt !== Number(match[3])) continue;
    attempts.push(value);
  }
  return attempts.sort((a, b) => a.rev - b.rev || a.attempt - b.attempt || a.step.localeCompare(b.step));
}

export type AttemptView = {
  key: string;
  step: string;
  rev: number;
  n: number;
  max: number;
  strategy: RecoveryStrategy;
  label: string;
  means: string;
  exhausted: boolean;
  /** Why recovery stopped, when it did. */
  reason: string | null;
  /** What earlier attempts observed, as handed to this attempt. Untrusted text. */
  observations: string[];
  current: boolean;
};

const ACTIVE_STEP: Partial<Record<TrailState, string[]>> = {
  researching: ["research"], reproducing: ["repro", "plan"], patching: ["patch"], proving: ["patch"],
};

function attemptViews(trail: Trail, recovery: readonly RecoveryArtifact[]): AttemptView[] {
  const state = trail.state === "parked" || trail.state === "handed_off" ? trail.resumeTo ?? trail.state : trail.state;
  const steps = ACTIVE_STEP[state] ?? [];
  const mine = recovery.filter((attempt) => attempt.trail === trail.id);
  const last = [...mine].reverse().find((attempt) => steps.includes(attempt.step));
  return mine.map((attempt) => ({
    key: `${attempt.step}-${attempt.rev}-${attempt.attempt}`, step: attempt.step, rev: attempt.rev, n: attempt.attempt,
    max: attempt.maxAttempts, strategy: attempt.strategy, label: STRATEGY_LABEL[attempt.strategy],
    means: STRATEGY_MEANS[attempt.strategy], exhausted: attempt.exhausted, reason: attempt.reason,
    observations: attempt.history.map((entry) => entry.observation).filter(Boolean), current: attempt === last,
  }));
}

// ───────────────────────── Attention ─────────────────────────
// Who holds the next move. This is the answer to "am I needed?", so it is computed, never styled by hand.

export const ATTENTION = ["needs_you", "held", "reverted", "recovering", "asking", "self", "set", "dropped"] as const;
export type Attention = (typeof ATTENTION)[number];
/** The three buckets a person scans for, plus finished work. */
export type AttentionGroup = "self" | "you" | "stopped" | "finished";
export const ATTENTION_GROUP: Record<Attention, AttentionGroup> = {
  self: "self", recovering: "self", asking: "self", reverted: "self", needs_you: "you", held: "stopped",
  set: "finished", dropped: "finished",
};
export const ATTENTION_LABEL: Record<Attention, string> = {
  self: "By itself", recovering: "Recovering", asking: "Asking", needs_you: "Needs you", held: "Stopped",
  reverted: "Rolling back", set: "Finished", dropped: "Dropped",
};

export type InboxLike = {
  trailId: string;
  kind: "checkpoint" | "spend" | "parked" | "notice";
  checkpoint?: Gate;
  blocking: boolean;
};

export type QuestAction =
  | { kind: "decide"; checkpoint: Gate; label: string }
  | { kind: "spend"; label: string }
  | { kind: "answer"; questionId: string; label: string }
  | { kind: "resume"; label: string }
  | { kind: "release"; label: string };

export type QuestionView = {
  id: string;
  status: InvestigationQuestion["status"];
  question: string;
  /** Why the answer changes the next step. */
  reason: string;
  acceptance: string;
  to: string;
  toYou: boolean;
  /** Why this person: the roles and areas the roster records for them. */
  because: string;
  delivery: string;
  checks: { phase: "question" | "answer"; model: string; accepted: boolean }[];
  answer: { text: string; by: string; accepted: boolean } | null;
  open: boolean;
};

const GATE_STATE: Partial<Record<TrailState, Gate>> = { hypothesised: "A", planned: "B", ready: "C" };
const GATE_NOUN: Record<Gate, string> = { A: "hypothesis", B: "plan", C: "landing" };
const OPEN_QUESTION = new Set<InvestigationQuestion["status"]>(["checking", "awaiting_answer"]);
const RISK_ORDER: Record<Risk, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `Array.prototype.findLast`, which the console's ES2022 lib does not have. */
export function lastOf<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return items[i];
  return undefined;
}
export const money = (microusd: number): string => `$${(microusd / 1_000_000).toFixed(2)}`;

function questionView(question: InvestigationQuestion, viewer: string | undefined): QuestionView {
  const recipient = question.recipient;
  const toYou = recipient === null || (viewer !== undefined && recipient.did === viewer);
  const because = recipient === null ? "No contact covers this area, so it falls to the workspace owner."
    : `${recipient.roles.join(", ") || "contact"}${recipient.areas.length ? ` for ${recipient.areas.join(", ")}` : ""}`;
  const delivery = question.delivery.status === "sent" ? `Sent by ${question.delivery.kind}`
    : question.delivery.status === "uncertain" ? "Delivery is uncertain; it will not be resent blindly" : "Not sent yet";
  return {
    id: question.id, status: question.status, question: question.question, reason: question.reason,
    acceptance: question.acceptance, to: recipient?.alias ?? "you", toYou, because, delivery,
    checks: question.checks.map(({ phase, model, accepted }) => ({ phase, model, accepted })),
    answer: question.answer ? { text: question.answer.text, by: question.answer.by, accepted: question.answer.accepted } : null,
    open: OPEN_QUESTION.has(question.status),
  };
}

/** The recorded reason a quest stopped, newest first. Null when the journal holds none. */
export function heldReason(events: readonly TrailEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "resumed") return null;
    if (event.type === "parked") return event.data.reason;
    if (event.type === "budget_exceeded") return event.data.summary;
    if (event.type === "agent_failed" && !event.data.retryable) return event.data.reason;
    if (event.type === "repro_completed" && !event.data.ok) return event.data.reason ?? "Could not reproduce the failure.";
    if (event.type === "landing_failed" && !event.data.baseMoved) return event.data.reason;
    if (event.type === "proof_completed" && !event.data.bundle.passed) return "Proof attempts are exhausted.";
  }
  return null;
}

// ───────────────────────── Budget ─────────────────────────

export type BudgetView = {
  tokens: { used: number; max: number; ratio: number };
  spend: { used: number; max: number; ratio: number | null };
  wall: { usedMs: number; maxMs: number; ratio: number };
  /** Core's reason this budget stops work, or null. */
  blocker: string | null;
};

export function budgetView(budget: Budget): BudgetView {
  const ratio = (used: number, max: number) => (max > 0 ? Math.min(1, used / max) : 0);
  const maxMs = budget.wallclockMaxS * 1000;
  return {
    tokens: { used: budget.tokensUsed, max: budget.tokensMax, ratio: ratio(budget.tokensUsed, budget.tokensMax) },
    spend: {
      used: budget.spendMicrousdUsed, max: budget.spendMicrousdMax,
      ratio: budget.spendMicrousdMax > 0 ? ratio(budget.spendMicrousdUsed, budget.spendMicrousdMax) : null,
    },
    wall: { usedMs: budget.wallclockUsedMs ?? 0, maxMs, ratio: ratio(budget.wallclockUsedMs ?? 0, maxMs) },
    blocker: budgetBlocker(budget),
  };
}

// ───────────────────────── Quest view ─────────────────────────

export type QuestInput = {
  trail: Trail;
  events?: readonly TrailEvent[];
  inbox?: readonly InboxLike[];
  questions?: readonly InvestigationQuestion[];
  recovery?: readonly RecoveryArtifact[];
  runs?: readonly AgentRun[];
  /** The signed-in principal. Without it nothing is ever addressed to "you". */
  viewer?: string;
};

export type QuestView = {
  id: string;
  short: string;
  title: string;
  area: string;
  risk: Risk;
  rev: number;
  state: TrailState;
  stage: Stage;
  progress: number;
  depth: number;
  attention: Attention;
  group: AttentionGroup;
  /** One line: what is happening to this quest right now. */
  headline: string;
  /** The reason, or the next step, when there is one worth a second line. */
  detail: string | null;
  persona: PersonaId | null;
  engine: string | null;
  executor: string | null;
  gate: { checkpoint: Gate; blocking: boolean } | null;
  /** The single primary action this viewer can take, if any. */
  action: QuestAction | null;
  attempts: AttemptView[];
  attempt: AttemptView | null;
  /** The current run of attempts at one step, oldest first: what was tried, in the order it was tried. */
  ladder: AttemptView[];
  proofAttempts: { used: number; max: number };
  question: QuestionView | null;
  questions: QuestionView[];
  /** Times the quest sank back down the loop: failed proofs, revisions, rollbacks. */
  retreats: number;
  budget: BudgetView;
  createdAt: string;
  updatedAt: string;
};

const WORKING = new Set<TrailState>(["researching", "reproducing", "patching", "proving"]);

/** The attempts that lead up to `current` at the same step: 1, 2, 3 and so on, across the revisions a patch creates. */
function ladderOf(attempts: readonly AttemptView[], current: AttemptView | null): AttemptView[] {
  if (!current) return [];
  const same = attempts.filter((entry) => entry.step === current.step);
  const ladder = [current];
  for (let i = same.indexOf(current) - 1; i >= 0 && same[i]!.n < ladder[0]!.n; i--) ladder.unshift(same[i]!);
  return ladder;
}

/** A plan is written while the state is still `reproducing`. True from a successful repro until the plan is in. */
function planning(trail: Trail, events: readonly TrailEvent[], run: AgentRun | undefined): boolean {
  if (trail.state !== "reproducing") return false;
  if (run) return run.step === "plan";
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "repro_completed") return event.data.ok;
    if (event.type === "checkpoint_decided") return event.data.checkpoint === "B" && event.data.decision.verdict === "revise";
  }
  return false;
}

/** How far through its watch window a landed quest is. Null when it is not being watched. */
export function watchProgress(
  trail: Pick<Trail, "state">, events: readonly TrailEvent[], now: string,
): { elapsedS: number; windowS: number; ratio: number } | null {
  if (trail.state !== "watching") return null;
  const started = lastOf(events, (event) => event.type === "watch_started");
  if (started?.type !== "watch_started") return null;
  const { windowS, startedAt } = started.data.config;
  const elapsedS = Math.min(windowS, Math.max(0, (Date.parse(now) - Date.parse(startedAt)) / 1000));
  return { elapsedS, windowS, ratio: windowS > 0 ? elapsedS / windowS : 1 };
}

export function questView(input: QuestInput): QuestView {
  const { trail, viewer } = input;
  const events = input.events ?? [];
  const inbox = (input.inbox ?? []).filter((item) => item.trailId === trail.id);
  const at = stageOf(trail);
  const attempts = attemptViews(trail, input.recovery ?? []);
  const attempt = attempts.find((entry) => entry.current) ?? null;
  const questions = (input.questions ?? []).filter((q) => q.trailId === trail.id).map((q) => questionView(q, viewer));
  const question = questions.find((q) => q.open) ?? questions.at(-1) ?? null;
  const pendingGate = GATE_STATE[trail.state];
  const gateItem = inbox.find((item) => item.kind === "checkpoint" && item.checkpoint === pendingGate);
  const gate = pendingGate ? { checkpoint: pendingGate, blocking: gateItem?.blocking ?? false } : null;
  const run = [...(input.runs ?? [])].reverse().find((entry) => entry.trailId === trail.id && entry.status === "running");
  const proofRetry = trail.attempts.proof > 0 && (trail.state === "patching" || trail.state === "proving");

  let attention: Attention = "self";
  let headline = planning(trail, events, run) ? "Planning the fix" : at.doing;
  let detail: string | null = null;
  let action: QuestAction | null = null;

  if (trail.state === "closed") {
    attention = "set";
    headline = "Finished. Proven, landed and watched clean.";
  } else if (trail.state === "abandoned") {
    attention = "dropped";
    headline = "Dropped";
    detail = heldReason(events);
  } else if (trail.state === "rolled_back") {
    attention = "reverted";
    headline = "Regressed in production. Rolling the change back.";
    const regression = lastOf(events, (event) => event.type === "probe_regressed_after_landing");
    detail = regression?.type === "probe_regressed_after_landing" ? regression.data.criterion : trail.watchEvidence ?? null;
  } else if (question?.open && question.status === "awaiting_answer" && question.toYou) {
    attention = "needs_you";
    headline = "Has a question only you can answer";
    detail = question.question;
    action = { kind: "answer", questionId: question.id, label: "Answer question" };
  } else if (question?.open) {
    attention = "asking";
    headline = question.status === "checking" ? "Checking a question before it is sent" : `Asking ${question.to}`;
    detail = question.question;
  } else if (trail.state === "handed_off") {
    const yours = viewer !== undefined && trail.owner?.id === viewer;
    attention = yours ? "needs_you" : "held";
    headline = yours ? "You are reviewing this quest" : "Someone else is reviewing this quest";
    if (yours) action = { kind: "release", label: "Release review" };
  } else if (trail.pendingSpend) {
    attention = "needs_you";
    headline = `Wants to spend ${money(trail.pendingSpend.microusd)}`;
    detail = trail.pendingSpend.purpose;
    action = { kind: "spend", label: `Approve ${money(trail.pendingSpend.microusd)}` };
  } else if (gate?.blocking) {
    attention = "needs_you";
    headline = `Waiting for you to approve the ${GATE_NOUN[gate.checkpoint]}`;
    action = { kind: "decide", checkpoint: gate.checkpoint, label: `Approve ${GATE_NOUN[gate.checkpoint]}` };
  } else if (trail.state === "parked") {
    attention = "held";
    const spent = lastOf(attempts, (entry) => entry.exhausted) ?? null;
    const tried = spent ? spent.n - 1 : 0;
    headline = trail.waitingForParent ? "Waiting for another quest to land first"
      : tried > 0 ? `Stopped after ${tried} ${plural(tried, "attempt", "attempts")}. It needs a new lead.` : "Stopped";
    detail = spent ? spent.observations.at(-1) ?? spent.reason : heldReason(events);
    // Resuming a quest whose recovery is spent only parks it again; it needs a new observation, not a button.
    if (!trail.waitingForParent && !spent) action = { kind: "resume", label: "Resume quest" };
  } else if (gate) {
    headline = `Policy is deciding the ${GATE_NOUN[gate.checkpoint]}`;
  } else if (WORKING.has(trail.state) && attempt && attempt.n > 1 && !attempt.exhausted) {
    attention = "recovering";
    headline = `${STRATEGY_DOING[attempt.strategy]} · attempt ${attempt.n} of ${attempt.max}`;
    detail = attempt.observations.at(-1) ?? null;
  } else if (proofRetry) {
    attention = "recovering";
    headline = `Proof failed. Patching again · attempt ${trail.attempts.proof + 1} of ${trail.attempts.maxProof}`;
  }

  const persona = run?.persona ?? (attention === "set" || attention === "dropped" ? null : at.persona);
  return {
    id: trail.id, short: trail.short, title: trail.title, area: trail.area, risk: trail.risk, rev: trail.rev,
    state: trail.state, stage: at, progress: progressOf(trail), depth: loopPoint(progressOf(trail)).depth,
    attention, group: ATTENTION_GROUP[attention], headline, detail, persona,
    engine: run?.engine ?? null, executor: run ? run.executor.kind : null, gate, action, attempts, attempt,
    ladder: ladderOf(attempts, attempt),
    proofAttempts: { used: trail.attempts.proof, max: trail.attempts.maxProof }, question, questions,
    retreats: journeyOf(events).filter((step) => step.kind === "retreat").length, budget: budgetView(trail.budget),
    createdAt: trail.createdAt, updatedAt: trail.updatedAt,
  };
}

/** Most deserving of a person's eye first: what needs them, then what stopped, then what is struggling. */
export function byAttention(a: QuestView, b: QuestView): number {
  return ATTENTION.indexOf(a.attention) - ATTENTION.indexOf(b.attention)
    || RISK_ORDER[a.risk] - RISK_ORDER[b.risk]
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

// ───────────────────────── Fleet ─────────────────────────

export type FleetView = {
  total: number;
  counts: Record<Attention, number>;
  groups: Record<AttentionGroup, number>;
  /** The one-sentence answer to "what is my software doing by itself, and am I needed?". */
  sentence: string;
  /** The quest a person should look at first, if any. */
  focus: string | null;
};

export function fleetView(quests: readonly QuestView[]): FleetView {
  const counts = Object.fromEntries(ATTENTION.map((key) => [key, 0])) as Record<Attention, number>;
  const groups: Record<AttentionGroup, number> = { self: 0, you: 0, stopped: 0, finished: 0 };
  for (const quest of quests) {
    counts[quest.attention]++;
    groups[quest.group]++;
  }
  const parts: string[] = [];
  if (groups.self) {
    const aside = [
      counts.recovering ? `${counts.recovering} recovering` : "",
      counts.asking ? `${counts.asking} asking someone` : "",
      counts.reverted ? `${counts.reverted} rolling back` : "",
    ].filter(Boolean).join(", ");
    parts.push(`${groups.self} ${plural(groups.self, "quest is moving by itself", "quests are moving by themselves")}`
      + (aside ? ` (${aside})` : ""));
  }
  if (groups.you) parts.push(`${groups.you} ${plural(groups.you, "needs you", "need you")}`);
  if (groups.stopped) parts.push(`${groups.stopped} ${plural(groups.stopped, "is stopped", "are stopped")}`);
  const sentence = parts.length ? `${parts.join(". ")}.` : quests.length
    ? "Nothing is in flight. Every quest is finished." : "Nothing is in flight. Production is quiet.";
  const focus = [...quests].sort(byAttention).find((quest) => quest.group !== "finished")?.id ?? null;
  return { total: quests.length, counts, groups, sentence, focus };
}

// ───────────────────────── Journey ─────────────────────────
// The path a quest took through the loop, drawn from its events alone. A policy decision at an advisory checkpoint
// leaves no event of its own, so a later event that can only happen further along implies the move ("catch-up").

export type JourneyKind = "advance" | "retreat" | "stay" | "hold" | "resume" | "end";
export type JourneyStep = {
  at: string;
  /** Event id, or null for a move implied by a later event. */
  event: string | null;
  type: TrailEvent["type"] | "implied";
  stage: StageId;
  kind: JourneyKind;
  text: string;
  /** 1 for the first descent, +1 for each rollback that sent the quest round again. */
  lap: number;
};

function occursIn(event: TrailEvent): StageId | null {
  switch (event.type) {
    case "research_completed": return "evidence";
    case "repro_completed": case "plan_completed": return "repro";
    case "patch_completed": return "patch";
    case "proof_completed": case "land_requested": return "proof";
    case "landing_completed": case "landing_failed": return "landing";
    case "watch_started": case "watch_completed": case "probe_regressed_after_landing": case "rollback_completed":
      return "watch";
    case "checkpoint_decided": return event.data.checkpoint === "A" ? "hypothesis" : event.data.checkpoint === "B" ? "patch" : "proof";
    default: return null;
  }
}

function leadsTo(event: TrailEvent, from: StageId): { stage: StageId; kind?: JourneyKind } {
  switch (event.type) {
    case "triage_completed": {
      const result = event.data.result;
      if (result.duplicateOf || result.route === "ignore") return { stage: from, kind: "end" };
      if (result.route === "human" || result.conflictsWith) return { stage: from, kind: "hold" };
      return { stage: "evidence" };
    }
    case "research_completed": return { stage: "hypothesis" };
    case "plan_completed": return { stage: "patch" };
    case "patch_completed": return { stage: "proof" };
    case "proof_completed": return event.data.bundle.passed ? { stage: "proof" } : { stage: "patch" };
    case "land_requested": return { stage: "landing" };
    case "landing_completed": return { stage: "watch" };
    case "landing_failed": return event.data.baseMoved ? { stage: "patch" } : { stage: from, kind: "hold" };
    case "base_moved": return { stage: "patch" };
    case "rollback_completed": return { stage: "evidence" };
    case "repro_completed": return event.data.ok ? { stage: from } : { stage: from, kind: "hold" };
    case "checkpoint_decided": {
      const { checkpoint, decision } = event.data;
      if (decision.shadow) return { stage: from };
      if (decision.verdict === "reject") return { stage: from, kind: "end" };
      const approve: Record<Gate, StageId> = { A: "repro", B: "patch", C: "landing" };
      const revise: Record<Gate, StageId> = { A: "evidence", B: "repro", C: "patch" };
      return { stage: decision.verdict === "approve" ? approve[checkpoint] : revise[checkpoint] };
    }
    case "watch_completed": case "killed": return { stage: from, kind: "end" };
    case "parked": case "budget_exceeded": case "claimed_by_human": return { stage: from, kind: "hold" };
    case "resumed": case "released_by_human": case "parent_trail_landed": return { stage: from, kind: "resume" };
    case "agent_failed": return { stage: from, kind: event.data.retryable ? "stay" : "hold" };
    default: return { stage: from };
  }
}

const kindOf = (from: StageId, to: StageId): JourneyKind =>
  STAGE_BY_ID[to].index > STAGE_BY_ID[from].index ? "advance" : STAGE_BY_ID[to].index < STAGE_BY_ID[from].index ? "retreat" : "stay";

export function journeyOf(
  events: readonly TrailEvent[], trail?: Pick<Trail, "state" | "resumeTo"> & { attempts?: Pick<Trail["attempts"], "maxProof"> },
): JourneyStep[] {
  const steps: JourneyStep[] = [];
  let cur: StageId = "signal";
  let lap = 1;
  // The machine stops a quest in place when its last allowed proof fails, without a `parked` event of its own.
  const maxProof = trail?.attempts?.maxProof ?? 3;
  let failedProofs = 0;
  let last = events[0]?.at ?? "";
  const imply = (to: StageId) => {
    const moved = kindOf(cur, to);
    const gate = moved === "advance" ? LOOP_STAGES.slice(STAGE_BY_ID[cur].index, STAGE_BY_ID[to].index + 1).find((s) => s.gate)?.gate : undefined;
    const text = gate ? `Policy passed checkpoint ${gate}. Moved on to ${STAGE_BY_ID[to].label.toLowerCase()}.`
      : `Moved to ${STAGE_BY_ID[to].label.toLowerCase()}.`;
    steps.push({ at: last, event: null, type: "implied", stage: to, kind: moved, text, lap });
    cur = to;
  };
  for (const event of events) {
    const needs = occursIn(event);
    if (needs && needs !== cur) imply(needs);
    let next = leadsTo(event, cur);
    if (event.type === "proof_completed" && !event.data.bundle.passed && ++failedProofs >= maxProof) next = { stage: cur, kind: "hold" };
    if (event.type === "rollback_completed") {
      lap++;
      failedProofs = 0;
    }
    steps.push({
      at: event.at, event: event.id, type: event.type, stage: next.stage,
      kind: next.kind ?? kindOf(cur, next.stage), text: narrate(event), lap,
    });
    cur = next.stage;
    last = event.at;
  }
  if (trail && STATE_STAGE[trail.state] && stageOf(trail).id !== cur) imply(stageOf(trail).id);
  return steps;
}

// ───────────────────────── Plain words ─────────────────────────
// Every event and effect has wording. A raw type name is never shown as the only description of what happened.

const GATE_NAME: Record<Gate, string> = { A: "the hypothesis", B: "the plan", C: "the landing" };
/** Where a change lands, in words. The exact mode and target stay in the receipt under the hood. */
const LANDING_WORDS: Record<LandingMode, string> = {
  trail_ref: "on the quest's own ref", devenv_live: "in the live development environment", radicle_patch: "as a Radicle patch",
  tangled_pull: "as a Tangled pull request", auto_land: "on the base branch",
};
/** A length of time in the unit a person would say it in. */
const span = (seconds: number): string => {
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds < 120) return say(Math.round(seconds), "second");
  if (seconds < 7200) return say(Math.round(seconds / 60), "minute");
  return say(Math.round(seconds / 3600), "hour");
};

export function narrate(event: TrailEvent): string {
  switch (event.type) {
    case "trail_created": return `A signal became a quest: ${event.data.title}`;
    case "new_signal": return "The same failure was seen again and merged into this quest.";
    case "triage_completed": {
      const r = event.data.result;
      const route = r.route === "auto_fix" ? "repair it automatically" : r.route === "research_only" ? "research only"
        : r.route === "human" ? "hand it to a person" : "ignore it";
      return `Triage: ${r.risk} risk in ${r.area}, severity ${r.severity.toFixed(1)}. Decided to ${route}.`;
    }
    case "research_completed": return "Research finished with a hypothesis.";
    case "checkpoint_decided": {
      const d = event.data.decision;
      const who = d.by === "human" ? d.who ?? "A person" : "Policy";
      const verb = d.verdict === "approve" ? "approved" : d.verdict === "revise" ? "sent back" : "rejected";
      return `${who} ${verb} ${GATE_NAME[event.data.checkpoint]}${d.shadow ? " (shadow, not applied)" : ""}`
        + `${d.note ? `: ${d.note}` : "."}`;
    }
    case "repro_completed":
      return event.data.ok ? "Reproduced the failure with a probe that fails on the current code."
        : `Could not reproduce: ${event.data.reason ?? "no reason recorded"}`;
    case "plan_completed": return "Planned the smallest change that makes the probe pass.";
    case "patch_completed": return `Wrote a patch (revision ${event.data.revision}, ${event.data.head.slice(0, 8)}).`;
    case "proof_completed":
      return event.data.bundle.passed ? "Proof passed."
        : `Proof failed. Missing: ${event.data.bundle.missing.join(", ") || "nothing named"}.`;
    case "land_requested": return "Landing was requested.";
    case "landing_completed": return `Landed ${LANDING_WORDS[event.data.receipt.mode]}.`;
    case "landing_failed":
      return event.data.baseMoved ? "Landing lost a race: the base moved. Rebasing the patch." : `Landing failed: ${event.data.reason}`;
    case "base_moved": return `The base moved to ${event.data.newSha.slice(0, 8)}. Rebasing the patch.`;
    case "watch_started": return `Watching production for ${span(event.data.config.windowS)}.`;
    case "watch_completed": return "Watch finished clean. The fix is set.";
    case "probe_regressed_after_landing": return `Production regressed after landing: ${event.data.criterion}.`;
    case "rollback_completed": return "Rolled the change back. Starting the investigation again with what was learned.";
    case "human_comment": return event.data.isRequest ? `Change requested: ${event.data.text}` : `Comment: ${event.data.text}`;
    case "claimed_by_human": return `${event.actor.id} took over the review.`;
    case "human_revision": return `${event.actor.id} revised the patch (${event.data.head.slice(0, 8)}).`;
    case "released_by_human": return `${event.actor.id} released the review.`;
    case "parked": return `Stopped: ${event.data.reason}`;
    case "resumed":
      return event.actor.id.startsWith("answer:") ? "Resumed with a checked answer as new evidence." : "Resumed.";
    case "killed": return `Dropped: ${event.data.reason}`;
    case "budget_exceeded": return `Budget reached: ${event.data.summary}`;
    case "usage_recorded": {
      const cost = event.data.costMicrousd === null ? "cost unknown" : money(event.data.costMicrousd);
      const tokens = event.data.tokens === null ? "tokens unknown" : `${event.data.tokens.toLocaleString("en-US")} tokens`;
      return `Usage recorded: ${tokens}, ${cost}.`;
    }
    case "spend_requested": return `Asked to spend ${money(event.data.microusd)}: ${event.data.purpose}`;
    case "spend_decided": return `Spend ${event.data.decision.verdict === "approve" ? "approved" : "declined"}.`;
    case "child_trail_finished": return "A dependent quest finished and handed over its proof.";
    case "parent_trail_landed": return "The quest this one was waiting on has landed.";
    case "intent_updated": return "Product intent changed. Re-running the intent probes.";
    case "policy_updated": return `The autonomy policy changed (${event.data.commit.slice(0, 8)}).`;
    case "mirror_linked": return `Linked to its ${event.data.kind} mirror.`;
    case "agent_failed":
      return `The ${event.data.step} step failed${event.data.retryable ? " and will be retried" : ""}: ${event.data.reason}`;
  }
}

export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case "run_triage": return "Run triage on the signal";
    case "start_agent": return `Start the ${effect.step} agent${effect.note ? ` with a note: ${effect.note}` : ""}`;
    case "run_proof": return "Run the proof";
    case "request_checkpoint":
      return `Checkpoint ${effect.checkpoint}: ${effect.blocking ? "wait for a person" : "ask policy to decide"}`;
    case "request_spend": return `Ask to spend ${money(effect.microusd)}`;
    case "land": return effect.modes.length ? `Land ${effect.modes.map((mode) => LANDING_WORDS[mode]).join(", or ")}` : "Land by the configured mode";
    case "rebase": return `Rebase onto ${effect.onto.slice(0, 8)}`;
    case "start_watch": return "Start watching production";
    case "rollback": return `Roll back: ${effect.criterion}`;
    case "register_regression_probe": return "Keep the probe as a regression test";
    case "notify_inbox": return `Tell the inbox: ${effect.reason}`;
    case "stop_agent": return "Stop the agent";
    case "merge_signal": return "Merge the duplicate signal";
    case "resume_dependents": return "Resume quests that were waiting on this one";
    case "mute_fingerprint": return "Mute this failure for a while";
    case "run_probes": return `Re-run probes: ${effect.reason}`;
    case "reply_comment": return "Reply on the quest";
    case "start_respondent_run": return `Start the approved study (${money(effect.microusd)})`;
    case "deliver_child_evidence": return "Hand a dependent quest's proof to this one";
  }
}

/** The persona that performs an effect, for showing who picked up the work. */
export function effectPersona(effect: Effect): PersonaId | null {
  if (effect.type === "start_agent") return personaFor(effect.step);
  if (effect.type === "run_proof" || effect.type === "run_probes") return "nema";
  if (effect.type === "run_triage" || effect.type === "merge_signal") return "rho";
  if (effect.type === "land" || effect.type === "start_watch" || effect.type === "rollback" || effect.type === "rebase") return "turri";
  return null;
}
