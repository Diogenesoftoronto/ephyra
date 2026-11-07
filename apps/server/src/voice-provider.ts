import { z } from "zod";
import type { BilledTo } from "./usage.ts";
import { ReconciliationRequired, type VoiceAudioInput } from "@ephyra/core";

export class VoiceError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422 | 503 | 504, message: string,
    readonly code = "voice_unavailable") { super(message); }
}
export type SpeechResult = {
  engine: string | null; tokens: number | null; costMicrousd: number | null;
};
export interface SpeechProvider {
  readonly kind: "notorganic" | "compatible";
  readonly billedTo: BilledTo;
  readonly transcriptionModel: string;
  readonly speechModel: string;
  readonly voice: string;
  readonly maxCostMicrousd: number | null;
  transcribe(input: VoiceAudioInput, key: string, signal: AbortSignal): Promise<SpeechResult & { text: string }>;
  speak(text: string, key: string, signal: AbortSignal): Promise<SpeechResult & { audio: string; mime: string }>;
}

const NumberOrNull = z.number().int().nonnegative().nullish();
const Transcript = z.object({ text: z.string().max(6000), model: z.string().min(1).optional(),
  usage: z.object({ total_tokens: NumberOrNull, cost_microusd: NumberOrNull }).optional() });
const EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3" };
const AUDIO = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/webm"]);

/** OpenAI-compatible audio transport. Credentials and endpoint selection are server-side only; no implicit model fallback. */
export class CompatibleSpeechProvider implements SpeechProvider {
  constructor(readonly options: {
    kind: SpeechProvider["kind"]; billedTo: BilledTo; baseUrl: string; transcriptionModel: string; speechModel: string; voice: string;
    maxCostMicrousd?: number; headers: (url: string) => Promise<Record<string, string>>; fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  }) {}
  get kind() { return this.options.kind; }
  get billedTo() { return this.options.billedTo; }
  get transcriptionModel() { return this.options.transcriptionModel; }
  get speechModel() { return this.options.speechModel; }
  get voice() { return this.options.voice; }
  get maxCostMicrousd() { return this.options.maxCostMicrousd ?? null; }

  private async request(path: string, body: BodyInit, key: string, signal: AbortSignal, json = false) {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/${path}`;
    let headers: Record<string, string>;
    try { headers = await this.options.headers(url); }
    catch { throw new VoiceError(503, "Voice credentials are unavailable. Reconnect the billing account."); }
    signal.throwIfAborted();
    try {
      const response = await (this.options.fetcher ?? fetch)(url, {
        method: "POST", redirect: "manual", body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        headers: { ...headers, "idempotency-key": key, ...(json ? { "content-type": "application/json" } : {}),
          ...(this.maxCostMicrousd !== null ? { "x-notorganic-max-cost-microusd": String(this.maxCostMicrousd) } : {}) },
      });
      if (!response.ok) {
        // A timeout, redirect or server failure can follow upstream acceptance. Never repeat the write.
        if (response.status < 400 || response.status >= 500 || response.status === 408 || response.status === 409)
          throw new ReconciliationRequired(key, "The speech provider's outcome is uncertain. Check Usage before starting another request.");
        throw new VoiceError(503, `The speech provider rejected the request (HTTP ${response.status}). Check its model, credentials and balance.`);
      }
      return response;
    } catch (e) {
      if (e instanceof VoiceError || e instanceof ReconciliationRequired) throw e;
      throw new ReconciliationRequired(key, "The speech request was interrupted. Its charge is unknown; check Usage before trying again.");
    }
  }
  async transcribe(input: VoiceAudioInput, key: string, signal: AbortSignal) {
    const form = new FormData();
    form.set("file", new Blob([Buffer.from(input.audio, "base64")], { type: input.mime }), `voice.${EXT[input.mime]}`);
    form.set("model", this.transcriptionModel);
    form.set("response_format", "json");
    const res = await this.request("audio/transcriptions", form, key, signal);
    const parsed = Transcript.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ReconciliationRequired(key, "The provider returned an unreadable transcript. Check Usage before recording again.");
    return { text: parsed.data.text.trim(), engine: parsed.data.model ?? null,
      tokens: parsed.data.usage?.total_tokens ?? null, costMicrousd: parsed.data.usage?.cost_microusd ?? null };
  }
  async speak(text: string, key: string, signal: AbortSignal) {
    const res = await this.request("audio/speech", JSON.stringify({ model: this.speechModel, voice: this.voice, input: text,
      response_format: "mp3" }), key, signal, true);
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!AUDIO.has(mime) || !res.body) throw new ReconciliationRequired(key, "The provider did not return playable audio. Check Usage before retrying.");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 8_000_000) throw new Error("audio too large");
        chunks.push(part.value);
      }
      if (!size) throw new Error("empty audio");
    } catch {
      throw new ReconciliationRequired(key, "Audio delivery did not finish. Its charge is unknown; check Usage before retrying.");
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    // Binary audio usually reports neither backend identity nor price. Do not substitute the requested alias for either.
    return { audio: Buffer.concat(chunks).toString("base64"), mime, engine: null, tokens: null, costMicrousd: null };
  }
}
