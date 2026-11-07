import { z } from "zod";
import { VoiceReceipt } from "./voice.ts";
import type { Trail } from "./schemas.ts";
import type { TrailEvent } from "./events.ts";

export const TutorBinding = z.object({
  rev: z.number().int().positive(),
  head: z.string().nullable(),
  proofDigest: z.string().nullable(),
  updatedAt: z.string(),
});
export type TutorBinding = z.infer<typeof TutorBinding>;
export const TutorInput = z.object({
  trailId: z.string().uuid(),
  bound: TutorBinding,
  question: z.string().trim().min(1).max(1000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(6000) }))
    .max(4)
    .default([]),
});
export type TutorInput = z.infer<typeof TutorInput>;
export const TutorCapabilities = z.object({
  provider: z.enum(["notorganic", "ampersand"]).nullable(),
  model: z.string().nullable(),
  maxCostMicrousd: z.number().int().nonnegative().nullable(),
});
export type TutorCapabilities = z.infer<typeof TutorCapabilities>;
export const TutorReply = z.object({
  text: z.string().min(1).max(6000),
  bound: TutorBinding,
  stale: z.boolean(),
  sources: z.array(z.object({ label: z.string(), excerpt: z.string() })),
  receipt: VoiceReceipt,
});
export type TutorReply = z.infer<typeof TutorReply>;

/** A tutor explanation is evidence about this exact snapshot, never an approval or a proof item. */
export function trailTutorBinding(trail: Trail, events: TrailEvent[]): TutorBinding {
  const proof = [...events]
    .reverse()
    .find((e) => e.type === "proof_completed" && e.data.bundle.rev === trail.rev && e.data.bundle.head === trail.head);
  return {
    rev: trail.rev,
    head: trail.head ?? null,
    updatedAt: trail.updatedAt,
    proofDigest: proof?.type === "proof_completed" ? proof.data.digest : null,
  };
}
