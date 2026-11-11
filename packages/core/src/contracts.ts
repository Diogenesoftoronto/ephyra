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

// ── Forecast extraction (additive) ──
// Clairic's `forecast` field as published in the Not Organic extraction contract v1 and Cloudflare's model page.
// Separate from ExtractionAnswer so existing consumers keep their scalar p10/p90 shape.
export const EXTRACTION_FORECAST_INTERVALS = ["step", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;
export const ExtractionForecastField = z.object({
  type: z.literal("forecast"),
  instructions: z.string().optional(),
  unit: z.string().max(40).optional(),
  min: z.number(),
  max: z.number(),
  horizon: z.number().int().min(1).max(64),
  interval: z.enum(EXTRACTION_FORECAST_INTERVALS),
}).refine((f) => f.max > f.min, { message: "max must exceed min" });
export type ExtractionForecastField = z.infer<typeof ExtractionForecastField>;
export const ExtractionForecastRequest = z.object({
  model: z.string().optional(),
  state: z.string().min(1),
  reference_date: z.string().optional(),
  fields: z.record(z.string(), ExtractionForecastField),
});
export type ExtractionForecastRequest = z.infer<typeof ExtractionForecastRequest>;
const ForecastStep = z.object({ value: z.number().nullable().optional(), median: z.number().optional(), p10: z.number().optional(), p90: z.number().optional() }).passthrough();
/** Both published answer forms: per-step estimates, or parallel median/p10/p90 arrays. */
export const ExtractionForecastAnswer = z.object({
  type: z.literal("forecast"),
  value: z.array(z.number()).nullable(),
  p_null: z.number().optional(),
  confidence: z.number().optional(),
  steps: z.array(ForecastStep).optional(),
  median: z.array(z.number()).optional(),
  p10: z.array(z.number()).optional(),
  p90: z.array(z.number()).optional(),
  mean: z.array(z.number()).optional(),
}).passthrough();
export type ExtractionForecastAnswer = z.infer<typeof ExtractionForecastAnswer>;
export const ExtractionForecastResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), ExtractionForecastAnswer),
  truncated: z.boolean().optional(),
  usage: z.object({ input_tokens: z.number().optional(), cost_microusd: z.number().nullable().optional() }).optional(),
});
export type ExtractionForecastResponse = z.infer<typeof ExtractionForecastResponse>;
export type ForecastPoint = { median: number; p10: number | null; p90: number | null };
/**
 * Normalise one forecast answer to `horizon` points. Returns null when the answer is malformed or incomplete
 * (wrong length, partial arrays, inverted intervals); a caller must then report an error, never fill gaps.
 */
export function forecastPoints(answer: ExtractionForecastAnswer, horizon: number): ForecastPoint[] | null {
  if (!answer.value || answer.value.length !== horizon) return null;
  let points: ForecastPoint[];
  if (answer.steps) {
    if (answer.steps.length !== horizon) return null;
    points = answer.steps.map((s, i) => ({ median: s.median ?? s.value ?? answer.value![i]!, p10: s.p10 ?? null, p90: s.p90 ?? null }));
  } else {
    for (const a of [answer.median, answer.p10, answer.p90]) if (a && a.length !== horizon) return null;
    points = answer.value.map((v, i) => ({ median: answer.median?.[i] ?? v, p10: answer.p10?.[i] ?? null, p90: answer.p90?.[i] ?? null }));
  }
  for (const p of points) {
    if (!Number.isFinite(p.median)) return null;
    if (p.p10 !== null && p.p90 !== null && (p.p10 > p.median || p.median > p.p90)) return null;
  }
  return points;
}
