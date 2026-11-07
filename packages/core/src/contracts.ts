// Wire contracts for System One backends. These mirror Not Organic's /v1/judgement and /v1/extraction
// (notorganic-provider packages/contracts/src/{judgement,extraction}.ts). BYOK and self-hosted backends
// speak the same shapes through adapters in @ephyra/models.
import { z } from "zod";

// ── Judgement (decide) ──
export const JudgementQuestion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), instructions: z.string(), criteria: z.object({ true: z.string(), false: z.string() }).optional() }),
  z.object({ type: z.literal("choice"), instructions: z.string(), criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string()) }),
]);
export type JudgementQuestion = z.infer<typeof JudgementQuestion>;

export const JudgementRequest = z.object({
  model: z.string().optional(),
  state: z.union([z.string(), z.record(z.string(), z.string())]),
  questions: z.record(z.string(), JudgementQuestion),
  images: z.array(z.string()).optional(),
  allow_fallback: z.boolean().optional(),
});
export type JudgementRequest = z.infer<typeof JudgementRequest>;

export const JudgementAnswer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
  z.object({
    type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), z.number()),
    legend: z.record(z.string(), z.string()), confidence: z.number(),
  }),
]);
export type JudgementAnswer = z.infer<typeof JudgementAnswer>;

export const JudgementResponse = z.object({
  /** Exact backend identity, e.g. "judgement-jev/jev-1.14". Thresholds are keyed by this. */
  model: z.string(),
  answers: z.record(z.string(), JudgementAnswer),
  fallback: z.object({ from: z.string(), to: z.string(), reason: z.string() }).optional(),
  usage: z.object({ input_tokens: z.number().optional(), cost_microusd: z.number().nullable().optional() }).optional(),
});
export type JudgementResponse = z.infer<typeof JudgementResponse>;

// ── Extraction ──
export const ExtractionFieldType = z.enum(["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"]);
export const ExtractionField = z.object({
  type: ExtractionFieldType,
  instructions: z.string(),
  integer: z.boolean().optional(),
  items: z.string().optional(),
});
export const ExtractionRequest = z.object({
  model: z.string().optional(),
  state: z.string(),
  reference_date: z.string().optional(),
  fields: z.record(z.string(), ExtractionField),
});
export type ExtractionRequest = z.infer<typeof ExtractionRequest>;

export const ExtractionAnswer = z.object({
  type: ExtractionFieldType,
  value: z.unknown().nullable(),
  guess: z.unknown().optional(),
  p_null: z.number().optional(),
  confidence: z.number().optional(),
  span: z.tuple([z.number(), z.number()]).optional(),
  spans: z.array(z.tuple([z.number(), z.number()])).optional(),
  p10: z.number().optional(),
  p90: z.number().optional(),
});
export type ExtractionAnswer = z.infer<typeof ExtractionAnswer>;

export const ExtractionResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), ExtractionAnswer),
  truncated: z.boolean().optional(),
  usage: z.object({ input_tokens: z.number().optional(), cost_microusd: z.number().nullable().optional() }).optional(),
});
export type ExtractionResponse = z.infer<typeof ExtractionResponse>;
