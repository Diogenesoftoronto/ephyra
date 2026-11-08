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
});
export type RepositoryConnection = z.infer<typeof RepositoryConnection>;
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
export const OnboardingUpdate = z
  .object({ expectedVersion: version, action: z.enum(["skip", "resume", "complete"]) })
  .strict();
export type OnboardingUpdate = z.infer<typeof OnboardingUpdate>;
