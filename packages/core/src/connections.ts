import { z } from "zod";

const version = z.number().int().nonnegative();
const workspace = z.string().min(1).max(100);
const secret = z.string().trim().min(1).max(8192).refine((value) => !/[\r\n\0]/.test(value));
export const ForgeRepositorySource = z.object({
  kind: z.enum(["git", "github", "gitlab", "forgejo", "radicle", "tangled"]),
  source: z.string().max(2048), repositoryId: z.string().max(1000).optional(),
  owner: z.string().max(1000).optional(), cloneUrl: z.string().max(2048).optional(),
});
export type ForgeRepositorySource = z.infer<typeof ForgeRepositorySource>;

export const TelemetryConnection = z.object({
  enabled: z.boolean(), workspaceId: workspace, provider: z.literal("posthog"), origin: z.string(), projectId: z.string(),
  keyConfigured: z.boolean(), includeRecordings: z.boolean(),
  status: z.enum(["saved", "verified", "unavailable"]), checkedAt: z.string().nullable(), detail: z.string(),
});
export type TelemetryConnection = z.infer<typeof TelemetryConnection>;
export const TelemetryUpdate = z.object({
  expectedVersion: version, workspaceId: workspace, enabled: z.boolean(),
  origin: z.string().trim().max(2048), projectId: z.string().trim().max(100), includeRecordings: z.boolean().default(false),
  apiKey: secret.optional(), clearKey: z.boolean().optional(),
}).strict();
export type TelemetryUpdate = z.infer<typeof TelemetryUpdate>;

export const InvestigationContact = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/), alias: z.string().trim().min(1).max(100),
  roles: z.array(z.enum(["maintainer", "operator", "product", "user"])).min(1).max(4),
  areas: z.array(z.string().min(1).max(100)).max(30),
  /** The account permitted to answer in Ephyra. Other recipients answer through their delivery bridge. */
  did: z.string().regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/).optional(),
});
export type InvestigationContact = z.infer<typeof InvestigationContact>;
const contacts = z.array(InvestigationContact).max(25)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length, "Contact IDs must be distinct.");
export const PeopleConnection = z.object({
  enabled: z.boolean(), workspaceId: workspace, contacts,
  webhookUrl: z.string().nullable(), keyConfigured: z.boolean(), updatedAt: z.string(),
});
export type PeopleConnection = z.infer<typeof PeopleConnection>;
export const PeopleUpdate = z.object({
  expectedVersion: version, workspaceId: workspace, enabled: z.boolean(), contacts,
  webhookUrl: z.string().trim().max(2048).optional(), token: secret.optional(), clearToken: z.boolean().optional(),
}).strict();
export type PeopleUpdate = z.infer<typeof PeopleUpdate>;

export const InvestigationQuestion = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), trailId: z.string(), workspaceId: workspace,
  bound: z.object({ rev: z.number().int().positive(), head: z.string() }),
  status: z.enum(["checking", "awaiting_answer", "answered", "rejected", "ambiguous", "superseded"]),
  question: z.string().max(2000), reason: z.string().max(2000), acceptance: z.string().max(2000),
  recipient: InvestigationContact.nullable(), createdAt: z.string(), updatedAt: z.string(),
  delivery: z.object({ kind: z.enum(["inbox", "webhook"]), status: z.enum(["not_sent", "sent", "uncertain"]), receipt: z.string().optional() }),
  answer: z.object({ text: z.string().max(4000), by: z.string(), at: z.string(), accepted: z.boolean() }).optional(),
  checks: z.array(z.object({ phase: z.enum(["question", "answer"]), model: z.string(), accepted: z.boolean(),
    request: z.unknown(), response: z.unknown() })).max(4),
});
export type InvestigationQuestion = z.infer<typeof InvestigationQuestion>;
export const InvestigationAnswer = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
export type InvestigationAnswer = z.infer<typeof InvestigationAnswer>;
