// Ephyra domain schemas. Source of truth: design/01-product-and-loop.md §2, §5, §8 and design/02-platform.md §1–§2.
// Changing a shape here is a cross-lane change: coordinate through the lead, never edit unilaterally.
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const Risk = z.enum(["low", "medium", "high", "critical"]);
export type Risk = z.infer<typeof Risk>;

/** What happens after triage. `ignore` only exists as a triage answer; a Trail never carries it. */
export const TriageRoute = z.enum(["auto_fix", "research_only", "human", "ignore"]);
export type TriageRoute = z.infer<typeof TriageRoute>;
export const Route = z.enum(["auto_fix", "research_only", "human"]);
export type Route = z.infer<typeof Route>;

export const TrailState = z.enum([
  "sensed", "triaged", "researching", "hypothesised", "reproducing", "planned", "patching", "proving",
  "ready", "landing", "watching", "closed", "rolled_back", "parked", "handed_off", "abandoned",
]);
export type TrailState = z.infer<typeof TrailState>;
export const TERMINAL_STATES: readonly TrailState[] = ["closed", "abandoned"];

export const Checkpoint = z.enum(["A", "B", "C"]);
export type Checkpoint = z.infer<typeof Checkpoint>;

export const LandingMode = z.enum(["devenv_live", "trail_ref", "radicle_patch", "tangled_pull", "auto_land"]);
export type LandingMode = z.infer<typeof LandingMode>;

export const Verdict = z.enum(["approve", "revise", "reject"]);
export type Verdict = z.infer<typeof Verdict>;

export const IsoTime = z.string().datetime({ offset: true });
export const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "full git object id");
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const Actor = z.object({
  kind: z.enum(["agent", "human", "system", "policy"]),
  id: z.string().min(1),
});
export type Actor = z.infer<typeof Actor>;

export const Decision = z.object({
  by: z.enum(["policy", "human"]),
  who: z.string().optional(),
  at: IsoTime,
  verdict: Verdict,
  note: z.string().optional(),
  /** Shadow-mode decisions are recorded but never advance a trail on their own. */
  shadow: z.boolean().optional(),
  /** Backend identity exactly as returned by the decide backend, e.g. "judgement-jev/jev-1.14". */
  backend: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

// ───────────────────────── Signals ─────────────────────────

export const SignalKind = z.enum([
  "error", "trace_anomaly", "log_anomaly", "intent_probe", "regression_replay", "story_probe",
  "hunter", "user_report", "forge_event",
]);
export type SignalKind = z.infer<typeof SignalKind>;

export const StackFrame = z.object({
  file: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  fn: z.string().optional(),
  /** True when the frame is application code rather than a dependency or runtime. */
  inApp: z.boolean(),
});
export type StackFrame = z.infer<typeof StackFrame>;

export const Signal = z.object({
  schema: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  kind: SignalKind,
  /** Stable workspace-scoped repository id (not a display name). */
  repo: z.string().min(1),
  environment: z.string().default("production"),
  service: z.string().optional(),
  /** HTTP route or operation name when known (used for error-rate baselines). */
  route: z.string().optional(),
  /** Normalised fingerprint; equal fingerprints are the same failure. */
  fingerprint: z.string().min(8),
  title: z.string().max(300),
  message: z.string().max(8000),
  exceptionType: z.string().optional(),
  frames: z.array(StackFrame).default([]),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  firstSeen: IsoTime,
  lastSeen: IsoTime,
  count: z.number().int().positive(),
  /** Free-form, already redacted attributes. Never secrets. */
  attributes: z.record(z.string(), z.string()).default({}),
  /** Where it came from: "otlp", "intent:<id>", "hunter:<id>", "forge:<adapter>", "user". */
  source: z.string(),
});
export type Signal = z.infer<typeof Signal>;

// ───────────────────────── Triage ─────────────────────────

export const TriageResult = z.object({
  route: TriageRoute,
  risk: Risk,
  area: z.string(),
  /** Jev-style score, 0–4 legend (0 cosmetic … 4 outage). */
  severity: z.number().min(0).max(4),
  actionable: z.number().min(0).max(1),
  duplicateOf: z.string().optional(),
  regressionOf: z.string().optional(),
  conflictsWith: z.string().optional(),
  /** Model confidence for the two answers the decision table gates on. */
  confidence: z.object({ route: z.number().min(0).max(1), duplicateOf: z.number().min(0).max(1) }),
  /** Exact backend identities returned by the providers. */
  backends: z.object({ extract: z.string().optional(), decide: z.string() }),
  /** Human-readable reasons produced by the decision table, in order applied. */
  reasons: z.array(z.string()),
  /** Notify a human in addition to the chosen route (e.g. severity ≥ 2.5). */
  notifyHuman: z.boolean().default(false),
});
export type TriageResult = z.infer<typeof TriageResult>;

// ───────────────────────── Proof ─────────────────────────

const Surface = z.enum(["web", "terminal"]);
export const ProofItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repro_before"), probe: z.string(), result: z.literal("fail"), log: z.string() }),
  z.object({ kind: z.literal("repro_after"), probe: z.string(), result: z.literal("pass"), log: z.string() }),
  z.object({
    kind: z.literal("tests"), suite: z.string(),
    passed: z.number().int(), failed: z.number().int(), newFailures: z.number().int(), log: z.string(),
  }),
  z.object({ kind: z.literal("regression_probes"), ran: z.array(z.string()), failed: z.array(z.string()) }),
  z.object({ kind: z.literal("intent_probes"), ran: z.array(z.string()), failed: z.array(z.string()) }),
  z.object({
    kind: z.literal("traffic_replay"), hunter: z.string(),
    diffs: z.number().int(), unexplained: z.number().int(), report: z.string(),
  }),
  z.object({ kind: z.literal("trace"), traceId: z.string(), note: z.string() }),
  z.object({
    kind: z.literal("bug_review"), reviewer: z.string(),
    findings: z.array(z.object({ severity: Risk, text: z.string(), file: z.string().optional(), line: z.number().int().optional() })),
  }),
  z.object({
    kind: z.literal("diff_scope"), files: z.number().int(), lines: z.number().int(),
    exportedTypesChanged: z.boolean(), paths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("story_render"), surface: Surface,
    stories: z.array(z.string()), failed: z.array(z.string()), uncovered: z.array(z.string()),
  }),
  z.object({ kind: z.literal("story_interaction"), surface: Surface, stories: z.array(z.string()), failed: z.array(z.string()), log: z.string() }),
  z.object({
    kind: z.literal("story_visual_diff"), surface: Surface, baselineSha: z.string(),
    changed: z.array(z.string()), explained: z.array(z.string()), artefacts: z.string(),
  }),
  z.object({ kind: z.literal("recording"), path: z.string(), what: z.string() }),
  z.object({ kind: z.literal("terminal_recording"), story: z.string(), tape: z.string(), what: z.string() }),
  /** Synthetic voxq persona run: evidence for user-facing medium-risk changes, never counted as human proof. */
  z.object({ kind: z.literal("persona_study"), study: z.string(), runId: z.string(), synthetic: z.literal(true), report: z.string() }),
  /** A named human approved each changed visual (high-risk UI). */
  z.object({ kind: z.literal("visual_approval"), by: z.string(), at: IsoTime, approved: z.array(z.string()) }),
  z.object({
    kind: z.literal("voxq_study"), study: z.string(), runId: z.string(), respondents: z.number().int(),
    via: z.enum(["share_link", "embed", "prolific"]), syntheticRunId: z.string().optional(),
    spendMicrousd: z.number().int(), expectMet: z.boolean(), report: z.string(),
  }),
]);
export type ProofItem = z.infer<typeof ProofItem>;
export type ProofItemKind = ProofItem["kind"];

/** Evidence availability is explicit: metadata alone never turns an incomplete run into proof. */
export const ProofStatus = z.enum(["passed", "failed", "unavailable", "expired"]);
export const ProofBundle = z.object({
  schema: z.literal(SCHEMA_VERSION),
  trail: z.string().uuid(),
  rev: z.number().int().positive(),
  risk: Risk,
  base: Sha,
  head: Sha,
  items: z.array(ProofItem),
  /** Requirements evaluated by @ephyra/policy; `missing` lists required kinds that are absent or failed. */
  passed: z.boolean(),
  missing: z.array(z.string()),
  /** Automated evidence passed; the separately recorded named-human checkpoint C is still required. */
  awaitingHumanC: z.boolean().optional(),
  /** Environment/lock/profile hashes the run was bound to. */
  env: z.object({ lockHash: z.string().optional(), profileDigest: z.string().optional(), runner: z.string() }),
  computedAt: IsoTime,
});
export type ProofBundle = z.infer<typeof ProofBundle>;

// ───────────────────────── Landing ─────────────────────────

export const LandingReceipt = z.object({
  mode: LandingMode,
  target: z.string(),
  oldOid: z.string().nullable(),
  newOid: z.string(),
  externalId: z.string().optional(),
  /** Exact external record version used by a conditional proposal update/revert. */
  externalVersion: z.string().optional(),
  externalRevision: z.string().optional(),
  authorizationId: z.string().optional(),
  proofDigest: Digest.optional(),
  /** devenv_live only: how to undo the live apply. */
  undo: z.object({ patch: z.string(), workingTreeHash: z.string() }).optional(),
  at: IsoTime,
});
export type LandingReceipt = z.infer<typeof LandingReceipt>;

export const WatchConfig = z.object({
  windowS: z.number().int().positive(),
  fingerprints: z.array(z.string()),
  touchedFiles: z.array(z.string()),
  routes: z.array(z.string()),
  areaProbes: z.array(z.string()),
  baseline: z.object({ errorRate: z.number().nonnegative(), p95Ms: z.number().nonnegative().optional() }),
  startedAt: IsoTime,
});
export type WatchConfig = z.infer<typeof WatchConfig>;

// ───────────────────────── Trail ─────────────────────────

export const Budget = z.object({
  tokensUsed: z.number().int().nonnegative(),
  tokensMax: z.number().int().positive(),
  wallclockMaxS: z.number().int().positive(),
  spendMicrousdUsed: z.number().int().nonnegative(),
  spendMicrousdMax: z.number().int().nonnegative(),
  /** Observed execution time; time waiting at checkpoints is not execution time. */
  wallclockUsedMs: z.number().int().nonnegative().optional(),
  /** Unknown usage is counted explicitly, never folded into a zero-cost receipt. */
  unknownCostEntries: z.number().int().nonnegative().optional(),
  unknownTokenEntries: z.number().int().nonnegative().optional(),
  requireKnownCost: z.boolean().optional(),
});
export type Budget = z.infer<typeof Budget>;

export const Trail = z.object({
  schema: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  /** Display form, e.g. "T-7f3a2c". */
  short: z.string(),
  repo: z.string(),
  title: z.string().max(200),
  rev: z.number().int().positive(),
  state: TrailState,
  /** State to return to on `resumed` (set when entering `parked`). */
  resumeTo: TrailState.optional(),
  signals: z.array(z.string().uuid()),
  area: z.string(),
  risk: Risk,
  route: Route,
  severity: z.number().min(0).max(4),
  base: z.object({ ref: z.string(), sha: Sha }),
  head: Sha.optional(),
  landing: z.object({ modes: z.array(LandingMode), target: z.string(), receipts: z.array(LandingReceipt) }).optional(),
  owner: z.object({ kind: z.enum(["agent", "human"]), id: z.string() }).optional(),
  checkpoints: z.object({
    A: Decision.optional(), B: Decision.optional(), C: Decision.optional(),
    spend: z.array(Decision).default([]),
  }),
  attempts: z.object({ proof: z.number().int().nonnegative(), maxProof: z.number().int().positive() }),
  budget: Budget,
  /** Last explicitly applied control-plane policy revision, when recorded by this runtime. */
  policyCommit: Sha.optional(),
  /** Monotonic ownership epoch; same-state retries cannot accept results from superseded work. */
  workGeneration: z.number().int().nonnegative().optional(),
  parent: z.string().uuid().optional(),
  signalFingerprint: z.string().optional(),
  waitingForParent: z.boolean().optional(),
  pendingSpend: z.object({ purpose: z.string(), microusd: z.number().int().positive() }).optional(),
  watchEvidence: z.string().optional(),
  mirrors: z.object({
    radicleCob: z.string().optional(), tangledUri: z.string().optional(), saplingStack: z.string().optional(),
    /** The Amp thread this trail's agent steps run in (design/03). */
    ampThread: z.string().optional(),
  }).default({}),
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Trail = z.infer<typeof Trail>;

/** What the post-landing watch observed so far. Collected by @ephyra/evidence, judged by @ephyra/policy (design/01 §8.3). */
export const WatchObservations = z.object({
  elapsedS: z.number().nonnegative(),
  fingerprintRecurrences: z.number().int().nonnegative(),
  newFingerprintsInTouchedFiles: z.array(z.string()),
  /** probe id → consecutive failures (0 = last run passed). */
  probeConsecutiveFailures: z.record(z.string(), z.number().int().nonnegative()),
  errorRate: z.object({ current: z.number().nonnegative(), baseline: z.number().nonnegative(), sustainedAboveS: z.number().nonnegative() }).nullable(),
  tracerNewClusters: z.number().int().nonnegative(),
  /** Missing or dropped telemetry: a gap is never a passing observation. */
  coverageGaps: z.array(z.string()),
});
export type WatchObservations = z.infer<typeof WatchObservations>;
