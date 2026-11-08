import { z } from "zod";

/** Agent-authored presentation, not proof of a run or permission to act. No file paths or host access. */
export const RunVisual = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  title: z.string().trim().min(1).max(160),
  html: z.string().min(1).max(240_000),
  height: z.number().int().min(160).max(1200).default(420),
}).refine((visual) => JSON.stringify(visual).length <= 256_000, "Visual exceeds the saved size limit");
export type RunVisual = z.infer<typeof RunVisual>;
