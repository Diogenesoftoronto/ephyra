// Console contracts: the shapes the web console (apps/console) reads from the server (apps/server).
// New export (additive); nothing here changes an existing core shape. design/05-console.md explains them.
import { z } from "zod";
import { IsoTime } from "./schemas.ts";

// ───────────────────────── Personas ─────────────────────────
// A persona is a role in the loop, not a model. The engine that plays it (claude-code, codex, amp, jev…) is recorded
// separately and exactly as returned, so usage can be read by persona and by engine.

export const PersonaId = z.enum(["rho", "bell", "nema", "lappet", "turri", "velum"]);
export type PersonaId = z.infer<typeof PersonaId>;

export type Persona = {
  id: PersonaId;
  name: string;
  role: string;
  /** The jellyfish part the name comes from. */
  namesake: string;
  blurb: string;
  /** Trail steps and jobs this persona performs. */
  does: string[];
  /** CSS custom property name for the persona's colour, defined by the console theme. */
  color: string;
};

export const PERSONAS: readonly Persona[] = [
  { id: "rho", name: "Rho", role: "Listener", namesake: "rhopalium, the jellyfish's sense organ",
    blurb: "Hears every production signal, merges duplicates and decides what deserves a trail.",
    does: ["extract", "triage"], color: "--persona-rho" },
  { id: "bell", name: "Bell", role: "Researcher", namesake: "the bell, the body that carries everything",
    blurb: "Gathers evidence from git, past trails and sessions, and writes the hypothesis you approve at A.",
    does: ["research", "evidence"], color: "--persona-bell" },
  { id: "nema", name: "Nema", role: "Prover", namesake: "nematocyst, the cell that stings to test",
    blurb: "Writes the failing reproduction, then runs the proof that the fix holds.",
    does: ["repro", "proof"], color: "--persona-nema" },
  { id: "lappet", name: "Lappet", role: "Mender", namesake: "lappet, the soft flap at the bell's edge",
    blurb: "Plans the smallest change that makes the reproduction pass, and writes the patch.",
    does: ["plan", "patch", "review"], color: "--persona-lappet" },
  { id: "turri", name: "Turri", role: "Watcher", namesake: "Turritopsis, the jellyfish that turns back time",
    blurb: "Watches production after a landing and rolls the change back if the error returns.",
    does: ["land", "watch", "rollback"], color: "--persona-turri" },
  { id: "velum", name: "Velum", role: "Scribe", namesake: "velum, the membrane that shapes the flow",
    blurb: "Drafts your autonomy policy, thresholds and intent documents with you.",
    does: ["draft"], color: "--persona-velum" },
];

/** Which persona performs a step or job. Unknown steps belong to no persona and stay visible as "unattributed". */
export function personaFor(step: string): PersonaId | null {
  return PERSONAS.find((p) => p.does.includes(step))?.id ?? null;
}

// ───────────────────────── Usage ─────────────────────────
// One row per billable or timed unit of work. Unknown cost is null, never 0; unavailable work is recorded as such.

export const UsageKind = z.enum(["extract", "triage", "agent_step", "proof", "sandbox", "draft", "study"]);
export const BilledTo = z.enum(["notorganic", "byok", "local", "unknown"]);

export const UsageEntry = z.object({
  id: z.string(),
  /** Stable key so retries and replays never double-count. */
  idempotencyKey: z.string(),
  at: IsoTime,
  kind: UsageKind,
  persona: PersonaId.nullable(),
  /** Step or job name, e.g. "research", "patch", "triage". */
  step: z.string(),
  /** Backend identity exactly as returned, e.g. "judgement-jev/jev-1.14", "claude-code/claude-opus-5-5". */
  engine: z.string(),
  trailId: z.string().uuid().nullable(),
  short: z.string().nullable(),
  tokens: z.number().int().nonnegative().nullable(),
  costMicrousd: z.number().int().nonnegative().nullable(),
  wallMs: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["ok", "failed", "unavailable"]),
  billedTo: BilledTo,
  /** Short human-readable reason for failed or unavailable work. Never contains secrets. */
  note: z.string().max(500).optional(),
});
export type UsageEntry = z.infer<typeof UsageEntry>;

export const UsageTotals = z.object({
  entries: z.number().int().nonnegative(),
  /** Sum of known costs only. */
  costMicrousd: z.number().int().nonnegative(),
  /** Entries whose cost is unknown; a UI must show these, not fold them into the total as zero. */
  unknownCost: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

const group = <K extends z.ZodTypeAny>(key: K) => z.array(z.object({ key, totals: UsageTotals }));

export const UsageSummary = z.object({
  from: IsoTime,
  to: IsoTime,
  totals: UsageTotals,
  byPersona: group(PersonaId.nullable()),
  byEngine: group(z.string()),
  byTrail: z.array(z.object({
    trailId: z.string().uuid(), short: z.string(), title: z.string(), totals: UsageTotals,
    budget: z.object({ spendMicrousdUsed: z.number().int(), spendMicrousdMax: z.number().int(), tokensUsed: z.number().int(), tokensMax: z.number().int() }),
  })),
  /** One bucket per UTC day in the window, oldest first, including empty days. */
  byDay: group(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

// ───────────────────────── Activity ─────────────────────────
// What the agents are doing now and did recently, derived from trail events and running jobs.

export const ActivityItem = z.object({
  id: z.string(),
  at: IsoTime,
  persona: PersonaId.nullable(),
  status: z.enum(["running", "done", "failed", "waiting"]),
  /** Plain sentence, e.g. "Writing the failing reproduction". */
  summary: z.string().max(300),
  trailId: z.string().uuid().nullable(),
  short: z.string().nullable(),
  engine: z.string().nullable(),
  /** For running items: when the step started, so the UI can show elapsed time. */
  startedAt: IsoTime.optional(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

// ───────────────────────── Policy documents and drafts ─────────────────────────

export const PolicyDocKind = z.enum(["autonomy", "thresholds", "intent"]);
export type PolicyDocKind = z.infer<typeof PolicyDocKind>;

export const PolicyDoc = z.object({
  /** Repository-relative path, e.g. "autonomy.md", "intents/checkout-flow.md". */
  path: z.string(),
  kind: PolicyDocKind,
  content: z.string(),
  /** SHA-256 of `content`; drafts are based on it and a publish is refused if it changed. */
  digest: z.string(),
  /** Parser warnings for the current content. */
  warnings: z.array(z.string()),
});
export type PolicyDoc = z.infer<typeof PolicyDoc>;

export const DraftProposal = z.object({
  /** Full proposed document text. */
  content: z.string(),
  summary: z.string().max(1000),
  /** Parser warnings for the proposed content; a proposal with errors cannot be applied. */
  warnings: z.array(z.string()),
  /** Higher-level form of the proposal for the application map; the server renders it to `content`. */
  sketches: z.array(z.lazy(() => AreaSketch)).optional(),
});
export type DraftProposal = z.infer<typeof DraftProposal>;

export const DraftMessage = z.object({
  id: z.string(),
  at: IsoTime,
  role: z.enum(["human", "persona", "system"]),
  persona: PersonaId.optional(),
  /** Human DID for human messages. */
  author: z.string().optional(),
  text: z.string().max(20000),
  /** A json-render spec validated against the console catalog (packages/genui). Never executable code. */
  spec: z.unknown().optional(),
  proposal: DraftProposal.optional(),
  usage: z.object({ engine: z.string(), tokens: z.number().int().nullable(), costMicrousd: z.number().int().nullable() }).optional(),
});
export type DraftMessage = z.infer<typeof DraftMessage>;

export const Draft = z.object({
  id: z.string(),
  path: z.string(),
  kind: PolicyDocKind,
  /** Digest of the document the draft started from. */
  baseDigest: z.string(),
  content: z.string(),
  warnings: z.array(z.string()),
  status: z.enum(["open", "published", "discarded"]),
  createdBy: z.string(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  messages: z.array(DraftMessage),
  /** Set after publish: where the change was written. */
  published: z.object({ ref: z.string(), commit: z.string(), by: z.string(), at: IsoTime }).optional(),
});
export type Draft = z.infer<typeof Draft>;

// ───────────────────────── Agent runs (live harness view) ─────────────────────────
// One run per agent step. Events are what the engine streamed (Amp / Claude Code stream-json, Codex JSON), normalized.
// Tool arguments and results are redacted and truncated by the server before storage; never secrets.

export const ExecutorKind = z.enum(["orb", "runner", "local", "railway", "notorganic"]);
export const AgentRun = z.object({
  id: z.string(),
  trailId: z.string().uuid().nullable(),
  short: z.string().nullable(),
  step: z.string(),
  persona: PersonaId.nullable(),
  /** Backend identity exactly as returned once known, e.g. "amp/smart", "claude-code/claude-opus-5-5". */
  engine: z.string(),
  executor: z.object({
    kind: ExecutorKind,
    /** Orb, runner or sandbox id when the engine reports one. */
    id: z.string().optional(),
    project: z.string().optional(),
    /** Live preview of the patched app (Amp orb portal, devenv_live). */
    portalUrl: z.string().url().optional(),
    /** The engine's own view of the run, e.g. https://ampcode.com/threads/T-… */
    threadUrl: z.string().url().optional(),
  }),
  status: z.enum(["running", "done", "failed", "unavailable"]),
  startedAt: IsoTime,
  endedAt: IsoTime.optional(),
  usage: z.object({ tokens: z.number().int().nullable(), costMicrousd: z.number().int().nullable() }).optional(),
  error: z.string().max(500).optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const AgentRunEvent = z.object({
  runId: z.string(),
  /** Monotonic per run; clients resume with ?after=<seq>. */
  seq: z.number().int().nonnegative(),
  at: IsoTime,
  type: z.enum(["message", "reasoning", "tool_call", "tool_result", "policy", "status", "portal"]),
  /** Assistant text, reasoning summary, or status line. */
  text: z.string().max(20000).optional(),
  tool: z.object({
    callId: z.string(), name: z.string(),
    /** Redacted JSON text, truncated. */
    args: z.string().max(4000).optional(),
    result: z.string().max(8000).optional(),
    isError: z.boolean().optional(),
  }).optional(),
  /** A harness plugin decision on a tool call (Ephyra's policy inside the agent loop). */
  policy: z.object({ decision: z.enum(["allow", "reject", "modify"]), rule: z.string(), reason: z.string().max(500) }).optional(),
  portalUrl: z.string().url().optional(),
});
export type AgentRunEvent = z.infer<typeof AgentRunEvent>;

// ───────────────────────── Higher-level drafting: the application map ─────────────────────────
// People describe areas of their application in plain language and pick a level on a five-step ladder. The policy package
// maps each level to concrete checkpoints, landing and watch settings; Velum proposes sketches, never raw settings alone.

export const AutonomyLevel = z.enum(["watch", "research", "propose", "patch", "auto"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const AUTONOMY_LEVELS: readonly { id: AutonomyLevel; label: string; means: string }[] = [
  { id: "watch", label: "Watch", means: "Notice and report. No trails are worked." },
  { id: "research", label: "Research", means: "Gather evidence and write a hypothesis. Nothing is changed." },
  { id: "propose", label: "Propose", means: "Reproduce and plan a fix; a person approves every step." },
  { id: "patch", label: "Patch", means: "Write and prove the fix; a person approves landing." },
  { id: "auto", label: "Auto-land", means: "Land proven small fixes alone, watch them, roll back on regression." },
];

export const AreaSketch = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60),
  /** Plain-language description of what this part of the app is and what matters about it. */
  intent: z.string().max(4000),
  paths: z.array(z.string()).max(50),
  risk: z.enum(["low", "medium", "high", "critical"]),
  level: AutonomyLevel,
  userFacing: z.boolean(),
  /** Monthly human-study budget, if any. */
  studyBudgetUsd: z.number().nonnegative().optional(),
});
export type AreaSketch = z.infer<typeof AreaSketch>;
