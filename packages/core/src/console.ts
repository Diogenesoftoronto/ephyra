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
