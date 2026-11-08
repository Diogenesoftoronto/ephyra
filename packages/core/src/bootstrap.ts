import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime();
export const BootstrapCoverage = z.object({
  id: z.enum(["repository", "checks", "telemetry", "deployment", "knowledge", "contact"]),
  status: z.enum(["observed", "configured", "missing", "unknown"]),
  summary: z.string().max(2000),
  checkedAt: time.optional(),
  references: z.array(z.string().max(2048)).max(30),
});
export type BootstrapCoverage = z.infer<typeof BootstrapCoverage>;

const actor = z.enum(["human", "agent"]);
export const BootstrapResponse = z.object({
  setupId: z.string().regex(/^[a-f0-9]{32}$/), head: sha, requestId: digest,
  text: z.string().trim().min(1).max(4000),
}).strict();
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;
export const BootstrapReport = z.object({
  setupId: z.string().regex(/^[a-f0-9]{32}$/), head: sha,
  summary: z.string().trim().min(1).max(6000),
  journeys: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    expectedBehavior: z.string().trim().min(1).max(2000),
    evidencePaths: z.array(z.string().min(1).max(500)).max(10),
  }).strict()).max(10).optional(),
}).strict();
export type BootstrapReport = z.infer<typeof BootstrapReport>;
export const BootstrapRequest = z.object({
  id: digest, kind: z.enum(["context", "configuration"]), gap: z.string().max(100).optional(),
  status: z.enum(["open", "answered", "resolved"]), question: z.string().max(2000),
  action: z.string().max(2000).optional(), options: z.array(z.string().max(300)).max(5),
  createdAt: time, updatedAt: time,
  /** Attributed context only. An answer never establishes a capability, permission or proof. */
  answer: z.object({
    text: z.string().max(4000), by: z.string().min(1).max(300), kind: actor, at: time,
    operationKey: z.string().max(160), digest,
  }).optional(),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequest>;

export const BootstrapAssessment = z.object({
  schema: z.literal(1), setupId: z.string().regex(/^[a-f0-9]{32}$/), head: sha,
  assessedAt: time, nextAssessmentAt: time,
  /** Pinned, bounded, redacted repository text. It remains untrusted source context. */
  sources: z.array(z.object({
    path: z.string().max(500), commit: sha, digest,
    kind: z.enum(["documentation", "manifest", "ci", "telemetry", "deployment"]),
    excerpt: z.string().max(6000),
  })).max(20),
  coverage: z.array(BootstrapCoverage).max(6), requests: z.array(BootstrapRequest).max(40),
  contextReports: z.array(z.object({
    id: digest, operationKey: z.string().max(160), digest,
    by: z.string().min(1).max(300), kind: actor, at: time,
    summary: z.string().max(6000), journeys: BootstrapReport.shape.journeys,
  })).max(20),
});
export type BootstrapAssessment = z.infer<typeof BootstrapAssessment>;
