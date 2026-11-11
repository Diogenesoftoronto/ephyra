import { describe, expect, test } from "bun:test";
import type { VoiceSpeech } from "@ephyra/core";
import { VoiceRequestError } from "../api.ts";
import type { VoiceAudio } from "../voice/audio.ts";
import { CompanionVoice } from "./voice.ts";

const caps = { provider: "compatible" as const, transcriptionModel: "stt", speechModel: "tts", voice: "v", conversation: true,
  maxRecordingMs: 60000, maxAudioBytes: 4000000, maxSpeechChars: 3000, maxCostMicrousd: null };
const clip: VoiceSpeech = { audio: "AQID", mime: "audio/mpeg", receipt: { operationKey: "k", engine: "tts", requestedModel: "tts", tokens: null, costMicrousd: null, billedTo: "local" } } as VoiceSpeech;
function audio(levels: number[] = [0.4]): VoiceAudio & { plays: number; recorded: number } {
  return {
    plays: 0, recorded: 0,
    prime() {}, stop() {}, dispose() {},
    async record(level) { this.recorded++; for (const l of levels) level(l); return { stop: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), cancel() {} }; },
    async play() { this.plays++; },
  };
}
function api(over: Partial<{ transcribe: () => Promise<{ text: string }>; speak: () => Promise<VoiceSpeech> }> = {}) {
  const calls: string[] = [];
  return { calls, voiceCapabilities: async () => caps,
    transcribe: async (_i: unknown, op: string) => { calls.push(`t:${op}`); return (over.transcribe ?? (async () => ({ text: " hello there " })))() as never; },
    speak: async (_t: string, op: string) => { calls.push(`s:${op}`); return (over.speak ?? (async () => clip))(); } };
}
let n = 0;
const key = () => `op-${n++}`;

describe("companion voice", () => {
  test("checking capabilities never records; recording puts editable text into the composer and sends nothing", async () => {
    const a = api(); const au = audio();
    const v = new CompanionVoice(a, au, key);
    await v.check();
    expect(au.recorded).toBe(0);
    let text = "";
    await v.record((t) => { text = t; });
    expect(v.getSnapshot().phase).toBe("listening");
    expect(v.getSnapshot().level).toBe(0.4);
    await v.finish((t) => { text = t; });
    expect(text).toBe("hello there");
    expect(v.getSnapshot().phase).toBe("idle");
  });
  test("an unknown transcription blocks recording again; acknowledging releases it", async () => {
    const a = api({ transcribe: async () => { throw new VoiceRequestError("reconciliation_required", "lost"); } });
    const v = new CompanionVoice(a, audio(), key);
    await v.check();
    await v.record(() => {});
    await v.finish(() => {});
    expect(v.getSnapshot().issue).toMatchObject({ kind: "uncertain", step: "transcribe" });
    await v.record(() => {});
    expect(v.getSnapshot().phase).toBe("idle");
    v.dismiss();
    expect(v.getSnapshot().issue?.kind).toBe("uncertain");
    v.acknowledge();
    await v.record(() => {});
    expect(v.getSnapshot().phase).toBe("listening");
  });
  test("replaying a reply reuses its saved audio", async () => {
    const a = api(); const au = audio();
    const v = new CompanionVoice(a, au, key);
    await v.check();
    await v.play("reply-1", "Payments is critical.");
    await v.play("reply-1", "Payments is critical.");
    expect(a.calls.filter((c) => c.startsWith("s:"))).toHaveLength(1);
    expect(au.plays).toBe(2);
    expect(v.getSnapshot().saved).toEqual(["reply-1"]);
  });
  test("rate limits report only the provider's wait; microphone denial keeps typing available", async () => {
    const limited = new CompanionVoice(api({ transcribe: async () => { throw new VoiceRequestError("rate_limited", "busy", "k"); } }), audio(), key);
    await limited.check();
    await limited.record(() => {});
    await limited.finish(() => {});
    expect(limited.getSnapshot().issue).toMatchObject({ kind: "rate-limited" });
    expect((limited.getSnapshot().issue as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
    const denied = audio();
    denied.record = async () => { throw new DOMException("no", "NotAllowedError"); };
    const v = new CompanionVoice(api(), denied, key);
    await v.check();
    await v.record(() => {});
    expect(v.getSnapshot().issue).toMatchObject({ kind: "microphone" });
    expect(v.getSnapshot().issue?.message).toContain("type your message");
  });
  test("cancel while transcribing stops input and keeps the request explicitly unconfirmed", async () => {
    let release!: () => void;
    const a = api({ transcribe: () => new Promise((r) => { release = () => r({ text: "late" }); }) });
    const v = new CompanionVoice(a, audio(), key);
    await v.check();
    await v.record(() => {});
    let text = "";
    const done = v.finish((t) => { text = t; });
    await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    v.cancel();
    release();
    await done;
    expect(text).toBe("");
    expect(v.getSnapshot().issue).toMatchObject({ kind: "uncertain" });
  });
});
