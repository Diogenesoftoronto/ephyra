import { z } from "zod";
import { KnowledgeConnection } from "./knowledge.ts";
import { ForgeRepositorySource, PeopleConnection, TelemetryConnection } from "./connections.ts";

/** Public account setup contracts. Saved credentials are never part of a response. */
export const ModelProvider = z.enum(["none", "notorganic", "openai", "anthropic", "compatible"]);
export type ModelProvider = z.infer<typeof ModelProvider>;
export const RepositoryConnection = z.object({
  url: z.string(),
  branch: z.string(),
  head: z.string(),
  verifiedAt: z.string(),
  credentialConfigured: z.boolean(),
  username: z.string().optional(),
  credentialHost: z.string().optional(),
  forge: ForgeRepositorySource.optional(),
  /** Additive: a GitHub App installation that mints this repository's tokens. Replaces a pasted token for GitHub. */
  githubApp: z.object({ installationId: z.string().regex(/^\d{1,15}$/), account: z.string().max(100), connectedAt: z.string() }).optional(),
});
export type RepositoryConnection = z.infer<typeof RepositoryConnection>;
/** A copy of the repository that Ephyra keeps in step after it moves the base branch. Tokens are never part of this. */
export const MirrorConnection = z.object({
  id: z.string().regex(/^m_[a-f0-9]{12}$/),
  url: z.string().max(2048),
  host: z.string().max(255),
  kind: z.enum(["git", "github", "gitlab", "forgejo"]),
  credentialConfigured: z.boolean(),
  last: z.object({ status: z.enum(["ok", "failed"]), at: z.string(), commit: z.string().optional(), detail: z.string().max(500) }).nullable(),
});
export type MirrorConnection = z.infer<typeof MirrorConnection>;
export const MirrorUpdate = z.object({
  expectedVersion: z.number().int().nonnegative(),
  url: z.string().trim().min(1).max(2048),
  token: z.string().trim().min(1).max(8192).refine((s) => !/[\r\n\0]/.test(s)).optional(),
}).strict();
export type MirrorUpdate = z.infer<typeof MirrorUpdate>;
export const MirrorRemove = z.object({ expectedVersion: z.number().int().nonnegative(), id: z.string().regex(/^m_[a-f0-9]{12}$/) }).strict();
export type MirrorRemove = z.infer<typeof MirrorRemove>;
export const ModelConnection = z.object({
  provider: ModelProvider,
  model: z.string(),
  baseUrl: z.string().nullable(),
  keyConfigured: z.boolean(),
  status: z.enum(["not_configured", "saved", "verified", "needs_sign_in", "unavailable"]),
  checkedAt: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ModelConnection = z.infer<typeof ModelConnection>;
export const AccountSettings = z.object({
  did: z.string(),
  version: z.number().int().nonnegative(),
  workspaceId: z.string(),
  repository: RepositoryConnection.nullable(),
  model: ModelConnection,
  onboarding: z.object({ status: z.enum(["new", "in_progress", "skipped", "complete"]), updatedAt: z.string() }),
  execution: z.literal("not_configured"),
  knowledge: KnowledgeConnection.optional(),
  telemetry: TelemetryConnection.optional(),
  people: PeopleConnection.optional(),
  automation: z.object({ provider: z.enum(["none", "railway", "custom"]), configured: z.boolean(), detail: z.string() }).optional(),
  /** Additive (design/10): copies kept in step after a landing moves the base branch. At most five. */
  mirrors: z.array(MirrorConnection).max(5).optional(),
  /** Additive: models for roles other than coding. Absent means the coding model does that job too. */
  roleModels: z.object({ review: ModelConnection.optional() }).strict().optional(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

const version = z.number().int().nonnegative();
const secret = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((s) => !/[\r\n\0]/.test(s), "The key contains an invalid character.");
export const RepositoryUpdate = z
  .object({
    expectedVersion: version,
    url: z.string().trim().min(1).max(2048),
    branch: z.string().trim().min(1).max(200),
    discoverDefaultBranch: z.boolean().optional(),
    username: z.string().trim().max(200).optional(),
    credentialHost: z.string().trim().max(2048).optional(),
    token: secret.optional(),
    clearToken: z.boolean().optional(),
  })
  .strict();
export type RepositoryUpdate = z.infer<typeof RepositoryUpdate>;
export const ModelUpdate = z
  .object({
    expectedVersion: version,
    provider: ModelProvider,
    model: z.string().trim().max(200),
    baseUrl: z.string().trim().max(2048).optional(),
    apiKey: secret.optional(),
    clearKey: z.boolean().optional(),
  })
  .strict();
export type ModelUpdate = z.infer<typeof ModelUpdate>;
/**
 * Which model does which job. `code` is the workspace model (research, repro, plan, patch); `review` checks every
 * patch. A role without its own model uses the coding model, and the proof records which model actually reviewed.
 */
export const AgentRole = z.enum(["code", "review"]);
export type AgentRole = z.infer<typeof AgentRole>;
const STEP_ROLE = { research: "code", repro: "code", plan: "code", patch: "code", review: "review" } as const;
export function roleForStep(step: keyof typeof STEP_ROLE): AgentRole { return STEP_ROLE[step]; }
/** A role model update has the same shape and checks as the workspace model, scoped to one role. */
export const RoleModelUpdate = ModelUpdate.extend({ role: AgentRole.exclude(["code"]) }).strict();
export type RoleModelUpdate = z.infer<typeof RoleModelUpdate>;
export const OnboardingUpdate = z
  .object({ expectedVersion: version, action: z.enum(["skip", "resume", "complete"]) })
  .strict();
export type OnboardingUpdate = z.infer<typeof OnboardingUpdate>;
