// A simulated hour of self-driving work, for the design lab and for tests.
// Every state here comes out of the real state machine (`createTrail`, `transition`): the script supplies only the
// facts an agent, the proof runner or production would report. Nothing ran. Proof bundles name the runner
// "fixture/no-execution" and the lab labels itself as a simulation, so none of this can pass for evidence.
import {
  budgetBlocker, createTrail, personaFor, proofDigest, sha256Hex, transition,
  type Actor, type AgentRun, type AgentRunEvent, type Decision, type Effect, type InvestigationQuestion, type LandingMode,
  type ProofBundle, type ProofItem, type Risk, type Signal, type Trail, type TrailEvent, type TrailEventBody, type TriageResult,
} from "@ephyra/core";
import {
  fleetView, journeyOf, lastOf, parseRecovery, questView,
  type FleetView, type Gate, type InboxLike, type JourneyKind, type QuestView, type RecoveryArtifact, type RecoveryStrategy,
} from "./model.ts";

export const T0 = Date.parse("2026-11-10T14:00:00.000Z");
export const TICK_MS = 15_000;
export const LAST_TICK = 240;
/** The moment the lab opens on: one quest recovering, one asking, one waiting on you, one rolling back, one stopped. */
export const HERO_TICK = 110;
export const VIEWER = "did:web:alex.example";
export const REPO = "acme/storefront";
export const DECIDE = "judgement-jev/jev-1.14";
export const tickTime = (tick: number, order = 0): string => new Date(T0 + tick * TICK_MS + order).toISOString();

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const uid = (kind: number, a: number, b: number) => `0193a0${hex(kind, 2)}-${hex(a, 4)}-7000-8000-${hex(b, 12)}`;
const questId = (hex6: string) => `0193a000-0000-7000-8000-000000${hex6}`;
const sha = (seed: string) => sha256Hex(seed).slice(0, 40);

// ───────────────────────── Script vocabulary ─────────────────────────

type Step = "research" | "repro" | "plan" | "patch";
type Make = (trail: Trail, at: string, quest: QuestScript) => TrailEventBody;
type Beat = { tick: number; make: Make; actor?: Actor };
type After = { in: number; make: Make; actor?: Actor };
type QuestionBeat = { tick: number } & Pick<InvestigationQuestion, "status" | "delivery" | "checks"> & {
  answer?: { text: string; by: string; accepted: boolean };
};

export type QuestScript = {
  hex: string;
  title: string;
  area: string;
  risk: Risk;
  severity: number;
  start: number;
  blocking: Record<Gate, boolean>;
  landing: LandingMode;
  signal: { kind: Signal["kind"]; service: string; route: string; exception?: string; message: string; count: number };
  files: string[];
  probe: string;
  hypothesis: string;
  /** What each patch attempt set out to do, in order. Shown as the agent's own words in its run. */
  approaches: string[];
  engines?: Partial<Record<Step, string>>;
  beats: Beat[];
  question?: {
    question: string; reason: string; acceptance: string;
    recipient: InvestigationQuestion["recipient"];
    beats: QuestionBeat[];
  };
  /** What follows a person's decision at a blocking checkpoint. */
  after?: { approve?: After[]; revise?: After[] };
};

const ENGINES: Record<Step, string> = {
  research: "amp/smart", repro: "codex/gpt-6.1-terra", plan: "claude-code/claude-opus-5-5", patch: "codex/gpt-6.1-terra",
};
const TOKENS: Record<Step, number> = { research: 48_000, repro: 31_000, plan: 22_000, patch: 64_000 };
const COMPLETES: Partial<Record<TrailEventBody["type"], Step>> = {
  research_completed: "research", repro_completed: "repro", plan_completed: "plan", patch_completed: "patch",
};
const SYSTEM = (id: string): Actor => ({ kind: "system", id });
const HUMAN: Actor = { kind: "human", id: VIEWER };

const research = (): Make => () => ({ type: "research_completed", data: { hypothesis: "hypothesis.md" } });
const repro = (): Make => (_t, _at, q) => ({ type: "repro_completed", data: { ok: true, probe: `.ephyra/repro/${q.probe}.sh` } });
const reproFailed = (reason: string): Make => () => ({ type: "repro_completed", data: { ok: false, reason } });
const plan = (): Make => () => ({ type: "plan_completed", data: { plan: "plan.md" } });
const patch = (): Make => (trail) => ({
  type: "patch_completed", data: { head: sha(`head:${trail.id}:${trail.rev + 1}`), revision: trail.rev + 1 },
});
const failed = (step: Step, reason: string): Make => () => ({ type: "agent_failed", data: { step, reason, retryable: true } });
const seenAgain = (n: number): Make => (trail) => ({
  type: "new_signal", data: { signalId: uid(0x51, Number.parseInt(trail.id.slice(-6), 16) % 0xffff, n), severity: trail.severity },
});

function proof(passed: boolean, missing: string[] = []): Make {
  return (trail, at, q) => {
    const probe = `.ephyra/repro/${q.probe}.sh`;
    const items: ProofItem[] = [
      { kind: "repro_before", probe, result: "fail", log: "fixture: no run" },
      ...(missing.includes("repro_after") ? [] : [{ kind: "repro_after" as const, probe, result: "pass" as const, log: "fixture: no run" }]),
      { kind: "tests", suite: "bun test", passed: 212, failed: 0, newFailures: 0, log: "fixture: no run" },
      {
        kind: "regression_probes", ran: ["refund-split-tender", "invoice-totals"],
        failed: missing.includes("regression_probes") ? ["refund-split-tender"] : [],
      },
      { kind: "diff_scope", files: q.files.length, lines: 14 + q.files.length * 9, exportedTypesChanged: false, paths: q.files },
    ];
    const bundle: ProofBundle = {
      schema: 1, trail: trail.id, rev: trail.rev, risk: trail.risk, base: trail.base.sha, head: trail.head ?? trail.base.sha,
      items, passed, missing, env: { runner: "fixture/no-execution" }, computedAt: at,
    };
    return { type: "proof_completed", data: { bundle, digest: proofDigest(bundle) } };
  };
}

const landed = (): Make => (trail, at, q) => ({
  type: "landing_completed",
  data: { receipt: { mode: q.landing, target: trail.base.ref, oldOid: trail.base.sha, newOid: trail.head ?? trail.base.sha, at } },
});
const watch = (minutes = 15): Make => (trail, at, q) => ({
  type: "watch_started",
  data: { config: {
    windowS: minutes * 60, fingerprints: [trail.signalFingerprint ?? q.hex], touchedFiles: q.files, routes: [q.signal.route],
    areaProbes: [q.probe], baseline: { errorRate: 0.004, p95Ms: 180 }, startedAt: at,
  } },
});
const clean = (): Make => () => ({ type: "watch_completed", data: { outcome: "clean" } });
const regressed = (criterion: string, evidence: string): Make => () => ({
  type: "probe_regressed_after_landing", data: { criterion, evidence },
});
const rolledBack = (): Make => (trail, at, q) => ({
  type: "rollback_completed",
  data: { receipt: { mode: q.landing, target: trail.base.ref, oldOid: trail.head ?? trail.base.sha, newOid: trail.base.sha, at } },
});

const happy = (t: number[], q: Pick<QuestScript, "hex">): Beat[] => {
  void q;
  const [r, rp, pl, pa, pr, la, cl] = t as [number, number, number, number, number, number, number | undefined];
  return [
    { tick: r, make: research() }, { tick: rp, make: repro() }, { tick: pl, make: plan() }, { tick: pa, make: patch() },
    { tick: pr, make: proof(true) }, { tick: la, make: landed() }, { tick: la, make: watch() },
    ...(cl === undefined ? [] : [{ tick: cl, make: clean() }]),
  ];
};

/** The facts a script can report. Exported so tests can walk the real state machine with the same vocabulary. */
export const moves = { research, repro, reproFailed, plan, patch, failed, proof, landed, watch, clean, regressed, rolledBack };
export type { Make, Step };

const ADVISORY = { A: false, B: false, C: false };
const SAM = { id: "sam", alias: "Sam", roles: ["operator" as const], areas: ["billing"], did: "did:web:sam.example" };
const MAYA = { id: "maya", alias: "Maya", roles: ["maintainer" as const], areas: ["storage"], did: "did:web:maya.example" };
const CHECK = (phase: "question" | "answer", accepted: boolean, response: string) => ({
  phase, model: DECIDE, accepted, request: { kind: "noul", fixture: true }, response: { verdict: accepted ? "yes" : "no", note: response },
});

export const QUESTS: readonly QuestScript[] = [
  {
    hex: "7f3a2c", title: "Tax rounding drifts on multi-currency invoices", area: "billing", risk: "medium", severity: 2.4,
    start: 4, blocking: ADVISORY, landing: "auto_land",
    signal: {
      kind: "error", service: "billing-api", route: "POST /invoices/:id/finalize", exception: "InvoiceTotalMismatch",
      message: "Invoice total 1204.37 JPY differs from the sum of its lines (1204) by 0.37", count: 37,
    },
    files: ["src/billing/round.ts", "src/billing/invoice.ts"], probe: "invoice-total-jpy",
    hypothesis: "Each line is rounded before the lines are summed, so drift accumulates on long invoices.",
    approaches: [
      "Round once, on the invoice total, instead of on every line.",
      "The minor unit is assumed to be 2 everywhere. JPY has none. Read it from the currency table.",
      "Tax uses banker's rounding and totals use half-up. Apply one mode at the ledger boundary.",
    ],
    beats: [
      { tick: 14, make: research() }, { tick: 24, make: repro() }, { tick: 32, make: plan() }, { tick: 46, make: patch() },
      { tick: 58, make: proof(false, ["repro_after"]) }, { tick: 78, make: patch() },
      { tick: 92, make: proof(false, ["regression_probes"]) }, { tick: 118, make: patch() },
      { tick: 134, make: proof(true) }, { tick: 138, make: landed() }, { tick: 138, make: watch() }, { tick: 198, make: clean() },
    ],
  },
  {
    hex: "b41e07", title: "Invoice PDF renders blank in Safari 17", area: "billing", risk: "low", severity: 1.8,
    start: 10, blocking: ADVISORY, landing: "auto_land",
    signal: {
      kind: "user_report", service: "web", route: "GET /invoices/:id/pdf",
      message: "Three customers report a blank page when opening an invoice PDF in Safari.", count: 3,
    },
    files: ["src/web/pdf/viewer.ts"], probe: "invoice-pdf-webkit",
    hypothesis: "The PDF blob URL is revoked before WebKit has finished reading it.",
    approaches: ["Revoke the blob URL after the viewer reports it has loaded, not on the next tick."],
    beats: [
      { tick: 22, make: research() },
      { tick: 40, make: reproFailed("The runner has no WebKit engine. The probe passes on Chromium and Firefox.") },
      { tick: 152, make: () => ({ type: "resumed", data: {} }), actor: SYSTEM(`answer:${sha256Hex("question:b41e07")}`) },
      { tick: 166, make: repro() }, { tick: 174, make: plan() }, { tick: 190, make: patch() },
      { tick: 204, make: proof(true) }, { tick: 208, make: landed() }, { tick: 208, make: watch() },
    ],
    question: {
      question: "Which Safari 17 version and OS showed the blank PDF, and does it still happen with \"Embed fonts\" turned off?",
      reason: "The failure only appears in WebKit, which the runner does not have. The version and the font setting decide "
        + "between the font-subsetting path and the blob-URL path.",
      acceptance: "A version number, and a yes or no on the font setting.",
      recipient: SAM,
      beats: [
        { tick: 44, status: "checking", delivery: { kind: "inbox", status: "not_sent" }, checks: [] },
        {
          tick: 48, status: "awaiting_answer", delivery: { kind: "inbox", status: "sent", receipt: "inbox:fixture" },
          checks: [CHECK("question", true, "Asks for a fact. Names one person. The answer changes the next step.")],
        },
        {
          tick: 150, status: "answered", delivery: { kind: "inbox", status: "sent", receipt: "inbox:fixture" },
          checks: [
            CHECK("question", true, "Asks for a fact. Names one person. The answer changes the next step."),
            CHECK("answer", true, "Answers both parts. Grants nothing. Treated as evidence, not as an instruction."),
          ],
          answer: { text: "Safari 17.4 on macOS 14.4. It still happens with Embed fonts off, so it is not the fonts.", by: "sam", accepted: true },
        },
      ],
    },
  },
  {
    hex: "c0ffee", title: "Webhook retry double-charges on gateway timeout", area: "payments", risk: "critical", severity: 3.6,
    start: 2, blocking: { A: false, B: false, C: true }, landing: "tangled_pull",
    signal: {
      kind: "error", service: "payments-worker", route: "POST /webhooks/psp", exception: "DuplicateChargeDetected",
      message: "Charge ch_… was captured twice for one order after a gateway timeout", count: 4,
    },
    files: ["src/payments/webhook.ts", "src/payments/idempotency.ts"], probe: "webhook-retry-idempotency",
    hypothesis: "The retry handler builds a new idempotency key instead of reusing the one from the first attempt.",
    approaches: [
      "Derive the idempotency key from the order and the event id, and store it before the first call.",
      "Keep the key derivation, and also reject a second capture for an order that is already captured.",
    ],
    beats: [
      { tick: 12, make: research() }, { tick: 22, make: repro() }, { tick: 30, make: plan() }, { tick: 44, make: patch() },
      { tick: 60, make: proof(true) },
    ],
    after: {
      approve: [{ in: 3, make: landed() }, { in: 3, make: watch() }, { in: 63, make: clean() }],
      revise: [{ in: 10, make: patch() }, { in: 20, make: proof(true) }],
    },
  },
  {
    hex: "d1a905", title: "Rate limiter rejects valid bursts after deploy", area: "gateway", risk: "low", severity: 2.1,
    start: 0, blocking: ADVISORY, landing: "auto_land",
    signal: {
      kind: "trace_anomaly", service: "gateway", route: "POST /api/*", exception: "RateLimited",
      message: "429 rate rose from 0.2% to 6.1% for authenticated clients after deploy 4c1e", count: 1820,
    },
    files: ["src/gateway/limiter.ts"], probe: "burst-within-quota",
    hypothesis: "The token bucket refills per instance, so a burst that lands on one instance is rejected.",
    approaches: [
      "Move the bucket to the shared store so all instances draw from one quota.",
      "Keep the shared bucket, and read it through the local cache with a 50 ms lease to protect latency.",
    ],
    beats: [
      ...happy([8, 16, 22, 32, 42, 46], { hex: "d1a905" }),
      { tick: 96, make: regressed("p95 latency on POST /api/* rose from 180 ms to 410 ms", "Minute 12 of the 15 minute watch window.") },
      { tick: 114, make: rolledBack() },
      ...happy([130, 146, 154, 170, 186, 190], { hex: "d1a905" }),
    ],
  },
  {
    hex: "e5cafe", title: "Digest email shows yesterday's date west of UTC", area: "email", risk: "low", severity: 1.2,
    start: 0, blocking: ADVISORY, landing: "auto_land",
    signal: {
      kind: "intent_probe", service: "mailer", route: "job digest.send",
      message: "The digest for 9 November was dated 8 November for a recipient in America/Vancouver", count: 1,
    },
    files: ["src/mailer/digest.ts"], probe: "digest-date-vancouver",
    hypothesis: "The date is formatted in UTC instead of the recipient's time zone.",
    approaches: ["Format the digest date in the recipient's zone."],
    beats: happy([5, 10, 14, 20, 28, 31, 91], { hex: "e5cafe" }),
  },
  {
    hex: "f00d42", title: "Search pagination skips page 3", area: "search", risk: "low", severity: 1.6,
    start: 84, blocking: ADVISORY, landing: "radicle_patch",
    signal: {
      kind: "error", service: "search-api", route: "GET /search", exception: "CursorOutOfRange",
      message: "Cursor for page 3 points past the result window when the page size is 24", count: 12,
    },
    files: ["src/search/cursor.ts"], probe: "search-page-3",
    hypothesis: "The cursor offset is computed from the default page size, not the requested one.",
    approaches: ["Compute the offset from the requested page size and carry it in the cursor."],
    beats: [
      { tick: 90, make: seenAgain(1) }, { tick: 96, make: research() }, { tick: 104, make: seenAgain(2) },
      ...happy([-1, 108, 116, 128, 140, 144, 204], { hex: "f00d42" }).slice(1),
    ],
  },
  {
    hex: "9a11ed", title: "Upload test flakes on slow disks", area: "storage", risk: "low", severity: 1.1,
    start: 20, blocking: ADVISORY, landing: "auto_land", engines: { repro: "amp/smart" },
    signal: {
      kind: "regression_replay", service: "ci", route: "test upload.resume",
      message: "upload.resume failed 3 of the last 40 runs, only on the slow-disk profile", count: 3,
    },
    files: ["src/storage/upload.ts"], probe: "upload-resume-slow-disk",
    hypothesis: "The resume offset is read before the previous chunk has been flushed.",
    approaches: [],
    beats: [
      { tick: 30, make: research() },
      { tick: 44, make: failed("repro", "The probe timed out after 120 s on the slow-disk profile.") },
      { tick: 56, make: failed("repro", "The probe timed out after 120 s on the slow-disk profile.") },
      { tick: 68, make: failed("repro", "The probe passed 50 of 50 times. The failure did not appear.") },
    ],
    question: {
      question: "Can you share the CI credentials for the storage bucket so the probe can run against the real disk?",
      reason: "The failure does not appear on the runner's disk.",
      acceptance: "Access to the bucket.",
      recipient: MAYA,
      beats: [
        { tick: 72, status: "checking", delivery: { kind: "inbox", status: "not_sent" }, checks: [] },
        {
          tick: 76, status: "rejected", delivery: { kind: "inbox", status: "not_sent" },
          checks: [CHECK("question", false, "Asks for a credential. A question may ask for a fact, never for access.")],
        },
      ],
    },
  },
];

// ───────────────────────── Recovery planning ─────────────────────────
// Mirrors `buildRecovery` in apps/server/src/wiring/recovery.ts, which the console cannot import. The lab uses it so the
// attempts it shows follow the server's rules (attempt counting, strategy ladder, exhaustion) instead of a hand-written story.

const GATE_FOR: Partial<Record<Step, Gate>> = { research: "A", plan: "B", patch: "C" };

export function planRecovery(trail: Trail, events: readonly TrailEvent[], step: Step, canResetContext: boolean): RecoveryArtifact {
  const relevant = events.filter((event) => event.rev === trail.rev && (
    (event.type === "agent_failed" && event.data.step === step)
    || (event.type === "checkpoint_decided" && event.data.decision.verdict === "revise" && event.data.checkpoint === GATE_FOR[step])
    || (step === "patch" && event.type === "proof_completed" && !event.data.bundle.passed)));
  const failures = relevant.filter((event) => event.type === "agent_failed").length;
  const revisions = relevant.filter((event) => event.type === "checkpoint_decided").length;
  const proofs = relevant.filter((event) => event.type === "proof_completed").length;
  const attempt = failures + revisions + (step === "patch" ? Math.max(trail.attempts.proof, proofs) : 0) + 1;
  const newEvidence = events.some((event) => event.type === "resumed" && event.rev === trail.rev
    && event.actor.kind === "system" && /^answer:[a-f0-9]{64}$/.test(event.actor.id));
  const maxAttempts = 3 + (newEvidence ? 1 : 0);
  const budgetSpent = budgetBlocker(trail.budget) !== null;
  const strategy: RecoveryStrategy = attempt === 1 ? "initial" : attempt === 2 ? "alternate_hypothesis"
    : canResetContext ? "fresh_context" : "additional_evidence";
  const reason = budgetSpent ? "The trail's existing budget is exhausted."
    : attempt > maxAttempts ? "Recovery attempts are exhausted; a new observation or explicit disposition is required." : null;
  return {
    schema: 1, trail: trail.id, rev: trail.rev, step, attempt, maxAttempts, strategy, exhausted: reason !== null, reason,
    retrySafety: "isolated", contextResetSupported: canResetContext, repeatedFailure: false,
    remainingTokens: Math.max(0, trail.budget.tokensMax - trail.budget.tokensUsed), omittedFromContext: 0,
    history: relevant.slice(-12).map((event) => ({
      event: event.id, revision: event.rev, type: event.type,
      observation: event.type === "agent_failed" ? event.data.reason
        : event.type === "checkpoint_decided" ? event.data.decision.note ?? "Reviewer requested a different approach."
          : event.type === "proof_completed" ? `Missing proof: ${event.data.bundle.missing.join(", ")}` : "",
    })),
  };
}

// ───────────────────────── Timeline ─────────────────────────

export type Injected = { quest: string; tick: number; action: "approve" | "revise" | "drop" | "resume"; note?: string };

type RunDraft = { id: string; step: Step; engine: string; start: number; end?: number; status: "done" | "failed"; attempt: number };
export type Frame = {
  tick: number;
  event: TrailEvent;
  trail: Trail;
  effects: Effect[];
  files: { path: string; content: string }[];
  /** A blocking checkpoint this frame opened, if any. */
  gate: Gate | null;
};
export type Timeline = {
  script: QuestScript; index: number; id: string; signal: Signal; triage: TriageResult; frames: Frame[]; runs: RunDraft[];
  /** Scripted facts the state machine refused. Always empty for an untouched script; a test holds it to that. */
  errors: string[];
};

function signalFor(q: QuestScript, index: number): Signal {
  const at = tickTime(q.start);
  return {
    schema: 1, id: uid(0x51, index, 0), kind: q.signal.kind, repo: REPO, environment: "production", service: q.signal.service,
    route: q.signal.route, fingerprint: sha(`fp:${q.hex}`).slice(0, 16), title: q.title, message: q.signal.message,
    ...(q.signal.exception ? { exceptionType: q.signal.exception } : {}),
    frames: q.files.map((file, line) => ({ file, line: 40 + line * 17, inApp: true })),
    firstSeen: at, lastSeen: at, count: q.signal.count, attributes: {}, source: "fixture",
  };
}

function triageFor(q: QuestScript): TriageResult {
  return {
    route: "auto_fix", risk: q.risk, area: q.area, severity: q.severity, actionable: 0.9,
    confidence: { route: 0.92, duplicateOf: 0.88 }, backends: { decide: DECIDE },
    reasons: [`area ${q.area} from the stack frames`, `risk ${q.risk} from the autonomy policy`, "no open quest has this fingerprint"],
    notifyHuman: false,
  };
}

type Pending = { tick: number; make: Make; actor?: Actor; scripted: boolean };

export function buildTimeline(q: QuestScript, index: number, injected: readonly Injected[] = []): Timeline {
  const id = questId(q.hex);
  const signal = signalFor(q, index);
  const triage = triageFor(q);
  const startAt = tickTime(q.start);
  const made = createTrail({
    id, signal, title: q.title, repo: REPO, base: { ref: "main", sha: sha(`base:${q.hex}`) }, triage, now: startAt,
    budget: { tokensUsed: 0, tokensMax: 1_500_000, wallclockMaxS: 7200, spendMicrousdUsed: 0, spendMicrousdMax: 12_000_000 },
  });
  if (!made.trail) throw new Error(`The script for ${q.hex} did not create a quest.`);
  let trail = made.trail;
  let seq = 0;
  let last: string | undefined;
  const timeline: Timeline = { script: q, index, id, signal, triage, frames: [], runs: [], errors: [] };
  const queue: Pending[] = q.beats.map((beat) => ({ ...beat, scripted: true }));
  const mine = injected.filter((entry) => entry.quest === id);
  for (const entry of mine) {
    const decision = (verdict: "approve" | "revise"): Make => (current, at) => ({
      type: "checkpoint_decided", data: {
        checkpoint: current.state === "hypothesised" ? "A" : current.state === "planned" ? "B" : "C",
        decision: { by: "human", who: VIEWER, at, verdict, ...(entry.note ? { note: entry.note } : {}) },
      },
    });
    const make: Make = entry.action === "approve" || entry.action === "revise" ? decision(entry.action)
      : entry.action === "drop" ? () => ({ type: "killed", data: { reason: entry.note ?? "A person dropped this quest." } })
        : () => ({ type: "resumed", data: {} });
    queue.push({ tick: entry.tick, make, actor: HUMAN, scripted: false });
    const follow = entry.action === "approve" ? q.after?.approve : entry.action === "revise" ? q.after?.revise : undefined;
    for (const beat of follow ?? []) queue.push({ tick: entry.tick + beat.in, make: beat.make, actor: beat.actor, scripted: false });
  }
  queue.sort((a, b) => a.tick - b.tick);

  const openRun = () => lastOf(timeline.runs, (run) => run.end === undefined);
  const startWork = (tick: number, effects: readonly Effect[], events: readonly TrailEvent[]): Frame["files"] => {
    const files: Frame["files"] = [];
    for (const effect of effects) {
      if (effect.type !== "start_agent" || effect.step === "review") continue;
      const engine = q.engines?.[effect.step] ?? ENGINES[effect.step];
      const recovery = planRecovery(trail, events, effect.step, /^(codex|claude-code)\//.test(engine));
      files.push({ path: `artefacts/recovery/${effect.step}-${trail.rev}-${recovery.attempt}.json`, content: JSON.stringify(recovery) });
      // The server parks instead of starting an agent once recovery is spent (wiring/agents.ts).
      if (recovery.exhausted) {
        queue.unshift({ tick, make: () => ({ type: "parked", data: { reason: recovery.reason ?? "Recovery needs new evidence." } }), scripted: true });
        continue;
      }
      timeline.runs.push({
        id: `run-${q.hex}-${timeline.runs.length + 1}`, step: effect.step, engine, start: tick, status: "done", attempt: recovery.attempt,
      });
    }
    return files;
  };
  const events = () => timeline.frames.map((frame) => frame.event);
  const push = (tick: number, event: TrailEvent, effects: Effect[]) => {
    const gate = effects.find((effect) => effect.type === "request_checkpoint" && effect.blocking);
    const frame: Frame = { tick, event, trail, effects, files: [], gate: gate?.type === "request_checkpoint" ? gate.checkpoint : null };
    timeline.frames.push(frame);
    frame.files = startWork(tick, effects, events());
    last = event.id;
  };
  const apply = (tick: number, body: TrailEventBody, actor: Actor, scripted: boolean) => {
    const at = tickTime(tick, timeline.frames.filter((frame) => frame.tick === tick).length);
    const event = { schema: 1, id: uid(0xe0, index, ++seq), trail: id, rev: trail.rev, at, actor, ...(last ? { parent: last } : {}), ...body } as TrailEvent;
    const policy: Decision = { by: "policy", at, verdict: "approve", backend: DECIDE };
    const result = transition(trail, event, {
      now: at, blocking: q.blocking, landingModes: [q.landing],
      autoDecision: Object.fromEntries((["A", "B", "C"] as const).filter((gate) => !q.blocking[gate]).map((gate) => [gate, policy])),
    });
    if (!result.ok) {
      if (scripted && mine.length === 0) timeline.errors.push(`${q.hex} tick ${tick} ${body.type}: ${result.error}`);
      return;
    }
    trail = result.trail;
    push(tick, event, result.effects);
  };

  push(q.start, {
    schema: 1, id: uid(0xe0, index, ++seq), trail: id, rev: 1, at: startAt, actor: SYSTEM("intake"),
    type: "triage_completed", data: { result: triage },
  }, made.effects);

  while (queue.length) {
    const next = queue.shift()!;
    const body = next.make(trail, tickTime(next.tick), q);
    const run = openRun();
    const closes = COMPLETES[body.type] ?? (body.type === "agent_failed" ? (body.data.step as Step) : undefined);
    if (run && closes === run.step) {
      const tokens = TOKENS[run.step] + ((index * 7919 + timeline.runs.length * 613) % 9000);
      apply(next.tick, {
        type: "usage_recorded",
        data: { operationKey: `run:${run.id}`, tokens, costMicrousd: tokens * 6, wallMs: (next.tick - run.start) * TICK_MS },
      }, SYSTEM("usage"), next.scripted);
      run.end = next.tick;
      run.status = body.type === "agent_failed" ? "failed" : "done";
    } else if (run && (body.type === "parked" || body.type === "killed")) {
      run.end = next.tick;
      run.status = "failed";
    }
    const agent = closes ? { kind: "agent" as const, id: personaFor(closes) ?? closes } : undefined;
    const system = body.type === "proof_completed" ? SYSTEM("proof")
      : body.type.startsWith("landing") || body.type === "rollback_completed" ? SYSTEM("landing")
        : body.type.startsWith("watch") || body.type === "probe_regressed_after_landing" ? SYSTEM("watch")
          : body.type === "new_signal" ? SYSTEM("intake") : SYSTEM("recovery");
    apply(next.tick, body, next.actor ?? agent ?? system, next.scripted);
  }
  return timeline;
}

// ───────────────────────── World at a tick ─────────────────────────

export type QuestWorld = {
  id: string;
  script: QuestScript;
  signal: Signal;
  triage: TriageResult;
  trail: Trail;
  events: TrailEvent[];
  /** What the state machine asked for, in order, with the event that caused each one. */
  effects: { tick: number; cause: string; effect: Effect }[];
  files: { path: string; content: string }[];
  runs: AgentRun[];
  questions: InvestigationQuestion[];
  inbox: InboxLike[];
  view: QuestView;
};
export type Beacon = { tick: number; quest: string; short: string; kind: JourneyKind | "born"; text: string };
export type World = {
  tick: number;
  at: string;
  quests: QuestWorld[];
  views: QuestView[];
  fleet: FleetView;
  /** Every notable moment in the whole hour, for the scrubber. */
  beacons: Beacon[];
};

const EXECUTOR: Record<string, AgentRun["executor"]["kind"]> = { amp: "orb", codex: "runner", "claude-code": "railway" };

function runAt(timeline: Timeline, run: RunDraft, tick: number): AgentRun {
  const ended = run.end !== undefined && run.end <= tick;
  const family = run.engine.split("/")[0] ?? "";
  return {
    id: run.id, trailId: timeline.id, short: `T-${timeline.script.hex}`, step: run.step, persona: personaFor(run.step), engine: run.engine,
    executor: { kind: EXECUTOR[family] ?? "runner", id: `${family}-${timeline.script.hex.slice(0, 4)}` },
    status: ended ? run.status : "running", startedAt: tickTime(run.start), ...(ended ? { endedAt: tickTime(run.end!) } : {}),
  };
}

function questionAt(timeline: Timeline, tick: number, trail: Trail): InvestigationQuestion[] {
  const q = timeline.script.question;
  const beat = (q ? lastOf(q.beats, (entry) => entry.tick <= tick) : undefined);
  if (!q || !beat) return [];
  return [{
    id: sha256Hex(`question:${timeline.script.hex}`), trailId: timeline.id, workspaceId: "fixture",
    bound: { rev: trail.rev, head: sha(`journal:${timeline.script.hex}`) },
    status: beat.status, question: q.question, reason: q.reason, acceptance: q.acceptance, recipient: q.recipient,
    createdAt: tickTime(q.beats[0]!.tick), updatedAt: tickTime(beat.tick), delivery: beat.delivery, checks: beat.checks,
    ...(beat.answer ? { answer: { ...beat.answer, at: tickTime(beat.tick) } } : {}),
  }];
}

function questAt(timeline: Timeline, tick: number): QuestWorld | null {
  const frames = timeline.frames.filter((frame) => frame.tick <= tick);
  const head = frames.at(-1);
  if (!head) return null;
  const trail = head.trail;
  const events = frames.map((frame) => frame.event);
  const files = frames.flatMap((frame) => frame.files);
  const runs = timeline.runs.filter((run) => run.start <= tick).map((run) => runAt(timeline, run, tick));
  const questions = questionAt(timeline, tick, trail);
  const waiting = ({ hypothesised: "A", planned: "B", ready: "C" } as const)[trail.state as "hypothesised" | "planned" | "ready"];
  const opened = waiting ? lastOf(frames, (frame) => frame.gate !== null) : undefined;
  const inbox: InboxLike[] = opened?.gate === waiting && waiting
    ? [{ trailId: timeline.id, kind: "checkpoint", checkpoint: waiting, blocking: true }] : [];
  const view = questView({ trail, events, inbox, questions, recovery: parseRecovery(files), runs, viewer: VIEWER });
  const effects = frames.flatMap((frame) => frame.effects.map((effect) => ({ tick: frame.tick, cause: frame.event.id, effect })));
  const { id, script, signal, triage } = timeline;
  return { id, script, signal, triage, trail, events, effects, files, runs, questions, inbox, view };
}

const cache = new Map<string, Timeline[]>();
export function timelines(injected: readonly Injected[] = []): Timeline[] {
  const key = JSON.stringify(injected);
  let built = cache.get(key);
  if (!built) {
    built = QUESTS.map((quest, index) => buildTimeline(quest, index, injected));
    if (cache.size > 24) cache.clear();
    cache.set(key, built);
  }
  return built;
}

function beaconsOf(all: readonly Timeline[]): Beacon[] {
  const beacons: Beacon[] = [];
  for (const timeline of all) {
    const short = `T-${timeline.script.hex}`;
    const steps = journeyOf(timeline.frames.map((frame) => frame.event));
    const tickOf = new Map(timeline.frames.map((frame) => [frame.event.id, frame.tick]));
    beacons.push({ tick: timeline.script.start, quest: timeline.id, short, kind: "born", text: `New signal: ${timeline.script.title}` });
    for (const step of steps) {
      if (!step.event || step.type === "usage_recorded" || step.type === "triage_completed" || step.kind === "stay" || step.kind === "advance") continue;
      beacons.push({ tick: tickOf.get(step.event) ?? 0, quest: timeline.id, short, kind: step.kind, text: step.text });
    }
  }
  return beacons.sort((a, b) => a.tick - b.tick);
}

export function worldAt(tick: number, injected: readonly Injected[] = []): World {
  const all = timelines(injected);
  const at = Math.min(LAST_TICK, Math.max(0, Math.round(tick)));
  const quests = all.map((timeline) => questAt(timeline, at)).filter((quest): quest is QuestWorld => quest !== null);
  const views = quests.map((quest) => quest.view);
  return { tick: at, at: tickTime(at), quests, views, fleet: fleetView(views), beacons: beaconsOf(all) };
}

// ───────────────────────── What an agent is doing right now ─────────────────────────

type Line = Pick<AgentRunEvent, "type" | "text" | "tool" | "policy">;
const call = (name: string, args: string, n: number): Line => ({ type: "tool_call", tool: { callId: `call-${n}`, name, args } });

function linesFor(q: QuestScript, run: RunDraft): Line[] {
  const file = q.files[0] ?? "src/index.ts";
  const allow = (rule: string, reason: string): Line => ({ type: "policy", policy: { decision: "allow", rule, reason } });
  if (run.step === "research") return [
    { type: "reasoning", text: "Reading the signal, its stack and the last three deploys." },
    call("telemetry.query", `errors where route = "${q.signal.route}" over 24h`, 1),
    call("Read", file, 2),
    { type: "message", text: `Hypothesis: ${q.hypothesis}` },
  ];
  if (run.step === "repro") return [
    { type: "reasoning", text: "Writing the smallest probe that fails for the reported reason." },
    call("Write", `.ephyra/repro/${q.probe}.sh`, 1),
    allow("probe-only", "The probe lives outside the application tree and is never committed."),
    call("bash", `.ephyra/repro/${q.probe}.sh  # three runs on the base commit`, 2),
    {
      type: "message",
      text: run.attempt > 1 ? "Trying a different way to make the failure appear."
        : "The probe must fail on the current code before any fix counts.",
    },
  ];
  if (run.step === "plan") return [
    { type: "reasoning", text: "Looking for the smallest change that makes the probe pass." },
    call("Read", file, 1),
    { type: "message", text: `Plan: ${q.approaches[0] ?? "Change one function and keep the public surface as it is."}` },
  ];
  return [
    { type: "reasoning", text: run.attempt > 1 ? "The last patch did not hold. Not repeating it." : "Applying the plan." },
    { type: "message", text: q.approaches[Math.min(run.attempt, q.approaches.length) - 1] ?? "Applying the plan." },
    call("Edit", file, 1),
    allow(`area:${q.area}`, `${file} is inside the ${q.area} area this quest may change.`),
    call("bash", "bun test", 2),
  ];
}

/** The lines an agent has streamed by `tick`, spread across the run. Canned text; see the note at the top of this file. */
export function runEventsAt(timeline: Timeline, runId: string, tick: number): AgentRunEvent[] {
  const run = timeline.runs.find((entry) => entry.id === runId);
  if (!run) return [];
  const lines = linesFor(timeline.script, run);
  const span = Math.max(lines.length + 1, (run.end ?? run.start + lines.length * 3) - run.start);
  return lines.flatMap((line, seq) => {
    const when = run.start + Math.max(1, Math.round(((seq + 1) * span) / (lines.length + 1)));
    return when <= tick ? [{ runId, seq, at: tickTime(when), ...line }] : [];
  });
}

/** One short line for "what is it doing this second": the newest thing its agent streamed. */
export function nowLine(timeline: Timeline, tick: number): string | null {
  const run = lastOf(timeline.runs, (entry) => entry.start <= tick && (entry.end === undefined || entry.end > tick));
  const event = run ? runEventsAt(timeline, run.id, tick).at(-1) : undefined;
  if (!event) return null;
  if (event.tool) return `${event.tool.name} ${event.tool.args ?? ""}`.trim();
  if (event.policy) return `Policy allowed it: ${event.policy.reason}`;
  return event.text ?? null;
}
