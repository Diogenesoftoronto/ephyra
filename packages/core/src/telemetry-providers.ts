import { z } from "zod";

/** Additional sources coexist with the original PostHog connection. */
export const TelemetryProvider = z.enum(["sentry", "crashlytics", "loki", "axiom", "betterstack", "datadog", "bugsnag"]);
export type TelemetryProvider = z.infer<typeof TelemetryProvider>;
const fields = {
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), provider: TelemetryProvider,
  workspaceId: z.string().min(1).max(100), enabled: z.boolean(),
  origin: z.string().trim().max(2048), project: z.string().trim().max(300),
  query: z.string().trim().max(2000).optional(),
};
export const TelemetrySourceConnection = z.object({ ...fields, keyConfigured: z.boolean(),
  status: z.enum(["saved", "verified", "unavailable"]), checkedAt: z.string().nullable(), detail: z.string().max(2000),
});
export type TelemetrySourceConnection = z.infer<typeof TelemetrySourceConnection>;
const secret = z.string().trim().min(1).max(8192).refine((s) => !/[\r\n\0]/.test(s));
export const TelemetrySourceUpdate = z.object({ ...fields, expectedVersion: z.number().int().nonnegative(),
  credentials: z.object({ apiKey: secret.optional(), applicationKey: secret.optional(), username: secret.optional(),
    serviceAccountJson: z.string().trim().min(1).max(16000).optional(),
  }).strict().refine((value) => Boolean(value.apiKey) !== Boolean(value.serviceAccountJson), "Provide a key or service account, not both.").optional(),
  clearKey: z.boolean().optional(),
}).strict();
export type TelemetrySourceUpdate = z.infer<typeof TelemetrySourceUpdate>;
