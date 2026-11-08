import { z } from "zod";

const sourceId = z.string().min(1).max(256);
const toolName = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** An exact, account-approved tool definition selected for automatic research. */
export const KnowledgeSearchTool = z.object({
  name: toolName,
  definitionHash: digest,
  queryField: z.string().min(1).max(80),
}).strict();
export type KnowledgeSearchTool = z.infer<typeof KnowledgeSearchTool>;

export const KnowledgeSelection = z.object({
  id: sourceId,
  resources: z.boolean(),
  searchTool: KnowledgeSearchTool.optional(),
}).strict().refine((value) => value.resources || value.searchTool !== undefined, "Choose resources or a research tool.");
export type KnowledgeSelection = z.infer<typeof KnowledgeSelection>;

const selections = z.array(KnowledgeSelection).max(8)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length, "Choose each source once.");

/** Workspace opt-in; upstream connection credentials and grants stay in Not Organic. */
export const KnowledgeConnection = z.object({
  enabled: z.boolean(),
  workspaceId: z.string().min(1),
  sources: selections,
  updatedAt: z.string(),
});
export type KnowledgeConnection = z.infer<typeof KnowledgeConnection>;

export const KnowledgeUpdate = z.object({
  expectedVersion: z.number().int().nonnegative(),
  workspaceId: z.string().min(1),
  enabled: z.boolean(),
  sources: selections,
}).strict().refine((value) => value.enabled || value.sources.length === 0, "Disabled knowledge cannot select sources.");
export type KnowledgeUpdate = z.infer<typeof KnowledgeUpdate>;

export const KnowledgeToolView = z.object({
  name: toolName,
  description: z.string().max(4000).optional(),
  definitionHash: digest,
  /** Present only for an eligible read-only tool with one supported string query argument. */
  queryField: z.string().min(1).max(80).nullable(),
  unavailableReason: z.string().max(500).nullable(),
});
export type KnowledgeToolView = z.infer<typeof KnowledgeToolView>;

export const KnowledgeSourceView = z.object({
  id: sourceId,
  label: z.string().max(300),
  resourcesAllowed: z.boolean(),
  tools: z.array(KnowledgeToolView).max(128),
});
export type KnowledgeSourceView = z.infer<typeof KnowledgeSourceView>;

export const KnowledgeCatalog = z.object({
  status: z.enum(["disabled", "needs_sign_in", "available", "unavailable"]),
  sources: z.array(KnowledgeSourceView).max(128),
  detail: z.string().max(1000),
  manageUrl: z.string(),
  authorizeUrl: z.string(),
});
export type KnowledgeCatalog = z.infer<typeof KnowledgeCatalog>;
