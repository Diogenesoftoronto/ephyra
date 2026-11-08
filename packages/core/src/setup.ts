import { z } from "zod";

/** Setup is a recorded workflow. Readiness is distinct from a connected repository. */
export const SetupMode = z.enum(["autonomous", "supervised"]);
export type SetupMode = z.infer<typeof SetupMode>;
export const SetupRequest = z.object({ mode: SetupMode.default("autonomous") }).strict();
export type SetupRequest = z.infer<typeof SetupRequest>;
export const SetupRun = z.object({
  id: z.string(),
  operationKey: z.string().optional(),
  mode: SetupMode,
  status: z.enum(["queued", "running", "blocked", "ready", "failed"]),
  /** Investigation may run while external landing/watch coverage is still blocked. */
  investigationActive: z.boolean().optional(),
  repository: z.object({ url: z.string(), branch: z.string(), head: z.string() }),
  startedAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(z.object({
    id: z.string(), name: z.string(),
    status: z.enum(["pending", "running", "complete", "blocked", "failed"]),
    detail: z.string(),
  })),
  artifacts: z.array(z.object({ path: z.string(), content: z.string(), digest: z.string() })),
  blockers: z.array(z.object({
    id: z.string(), summary: z.string(), action: z.string(), owner: z.enum(["operator", "maintainer"]),
  })),
  policyRef: z.string().optional(),
});
export type SetupRun = z.infer<typeof SetupRun>;
