// Additive voice contracts. Audio is transient; these schemas grant no trail or policy capabilities.
import { z } from "zod";
import { BilledTo } from "./console.ts";
import { VelumReference, VelumResolvedReference, VELUM_MAX_REFERENCES } from "./velum.ts";

export const VOICE_MAX_AUDIO_BYTES = 4_000_000;
export const VOICE_MAX_RECORDING_MS = 60_000;
export const VOICE_MAX_SPEECH_CHARS = 3000;
export const VoiceContext = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("overview") }),
  z.object({ kind: z.literal("usage") }),
  z.object({ kind: z.literal("trail"), id: z.string().uuid() }),
  z.object({ kind: z.literal("run"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("draft"), id: z.string().min(1).max(200) }),
]);
export type VoiceContext = z.infer<typeof VoiceContext>;
export const VoiceMessage = z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1).max(6000) });
export type VoiceMessage = z.infer<typeof VoiceMessage>;
export const VoiceReplyInput = z.object({
  context: VoiceContext, messages: z.array(VoiceMessage).min(1).max(20),
  /** Additive: parts of the console the person explicitly referred to. Resolved and bounded on the server. */
  references: z.array(VelumReference).max(VELUM_MAX_REFERENCES).optional(),
});
export type VoiceReplyInput = z.infer<typeof VoiceReplyInput>;
export const VoiceCapabilities = z.object({
  provider: z.enum(["notorganic", "compatible"]).nullable(),
  // Configured choices, not claims that the provider has answered or billed anything.
  transcriptionModel: z.string().nullable(), speechModel: z.string().nullable(), voice: z.string().nullable(),
  conversation: z.boolean(), maxRecordingMs: z.number(), maxAudioBytes: z.number(), maxSpeechChars: z.number(),
  maxCostMicrousd: z.number().int().nullable(),
});
export type VoiceCapabilities = z.infer<typeof VoiceCapabilities>;
export const VoiceReceipt = z.object({
  operationKey: z.string(), engine: z.string().nullable(), requestedModel: z.string(),
  tokens: z.number().int().nonnegative().nullable(), costMicrousd: z.number().int().nonnegative().nullable(), billedTo: BilledTo,
});
export type VoiceReceipt = z.infer<typeof VoiceReceipt>;
export const VoiceTranscript = z.object({ text: z.string().max(6000), receipt: VoiceReceipt });
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;
export const VoiceSpeech = z.object({ audio: z.string().max(11_000_000), mime: z.string(), receipt: VoiceReceipt });
export type VoiceSpeech = z.infer<typeof VoiceSpeech>;
export const VoiceReply = z.object({
  text: z.string().max(6000), contextLabel: z.string(), receipt: VoiceReceipt,
  /** Additive: what the server read for each reference. */
  references: z.array(VelumResolvedReference).optional(),
});
export type VoiceReply = z.infer<typeof VoiceReply>;
export const VoiceAudioInput = z.object({
  audio: z.string().min(4).max(Math.ceil(VOICE_MAX_AUDIO_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mime: z.enum(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"]),
});
export type VoiceAudioInput = z.infer<typeof VoiceAudioInput>;
export const VoiceSpeechInput = z.object({ text: z.string().trim().min(1).max(VOICE_MAX_SPEECH_CHARS) });
