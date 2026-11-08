import { expect, test } from "bun:test";
import fc from "fast-check";
import { FakeApi } from "../fake/api.ts";
import { VoiceSession, speechChunks, type VoiceTarget } from "./session.ts";
import type { VoiceAudio } from "./audio.ts";
import type { VoiceCapabilities, VoiceReceipt } from "@ephyra/core";
import { VoiceRequestError } from "../api.ts";

const CAP: VoiceCapabilities = {
  provider: "compatible",
  transcriptionModel: "fixture-stt",
  speechModel: "fixture-tts",
  voice: "fixture",
  conversation: true,
  maxRecordingMs: 60000,
  maxAudioBytes: 4000000,
  maxSpeechChars: 3000,
  maxCostMicrousd: null,
};
const receipt = (operationKey: string): VoiceReceipt => ({
  operationKey,
  engine: "fixture",
  requestedModel: "fixture",
  tokens: null,
  costMicrousd: null,
  billedTo: "local",
});
const target: VoiceTarget = { mode: "talk", context: { kind: "overview" }, label: "Application overview" };
function fixture() {
  const calls: string[] = [];
  const api = new FakeApi();
  api.voiceCapabilities = async () => CAP;
  api.transcribe = async (_input, op) => {
    calls.push("transcribe");
    return { text: "Explain this quest", receipt: receipt(op) };
  };
  api.voiceReply = async (_input, op) => {
    calls.push("reply");
    return { text: "A proof is missing.", contextLabel: "test", receipt: receipt(op) };
  };
  api.speak = async (_text, op) => {
    calls.push("speak");
    return { audio: "AQID", mime: "audio/mpeg", receipt: receipt(op) };
  };
  const audio: VoiceAudio = {
    prime: () => {},
    record: async () => ({
      stop: async () => new Blob(["fixture"], { type: "audio/webm" }),
      cancel: () => calls.push("cancel-capture"),
    }),
    play: async () => {
      calls.push("play");
    },
    stop: () => {},
    dispose: () => {},
  };
  let seq = 0;
  const session = new VoiceSession(api, audio, () => `fixture-op-${++seq}`);
  return { session, api, calls, audio };
}

test("spoken turns keep both captions and actual receipts", async () => {
  const f = fixture();
  await f.session.open(target);
  await f.session.begin();
  await f.session.finish();
  expect(f.calls).toEqual(["transcribe", "reply", "speak", "play"]);
  expect(f.session.getSnapshot().turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(f.session.getSnapshot().receipts).toHaveLength(3);
  expect(f.session.getSnapshot().target?.label).toBe("test");
  expect(f.session.getSnapshot().phase).toBe("ready");
  f.session.close();
});
test("dictation only inserts after review, never sends or generates speech", async () => {
  const f = fixture();
  let inserted = "";
  await f.session.open({
    ...target,
    mode: "dictate",
    insert: (t) => {
      inserted = t;
    },
  });
  await f.session.begin();
  await f.session.finish();
  expect(f.session.getSnapshot().phase).toBe("review");
  expect(inserted).toBe("");
  expect(f.calls).toEqual(["transcribe"]);
  f.session.insert("My corrected words");
  expect(inserted).toBe("My corrected words");
  expect(f.session.getSnapshot().phase).toBe("closed");
});
test("late permission cannot open a microphone after close", async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<VoiceAudio["record"]>>) => void;
  f.audio.record = () =>
    new Promise((r) => {
      resolve = r;
    });
  await f.session.open(target);
  const pending = f.session.begin();
  f.session.close();
  let cancelled = false;
  resolve({
    stop: async () => new Blob(),
    cancel: () => {
      cancelled = true;
    },
  });
  await pending;
  expect(cancelled).toBe(true);
  expect(f.session.getSnapshot().phase).toBe("closed");
  expect(f.calls).toEqual([]);
});
test("a late transcription cannot be appended to a different document", async () => {
  const f = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof f.api.transcribe>>) => void;
  f.api.transcribe = () =>
    new Promise((r) => {
      resolve = r;
    });
  await f.session.open({ ...target, context: { kind: "draft", id: "first" } });
  await f.session.begin();
  const pending = f.session.finish();
  await new Promise((r) => setTimeout(r, 0));
  await f.session.open({ ...target, context: { kind: "draft", id: "second" } });
  resolve({ text: "Change the first document", receipt: receipt("late") });
  await pending;
  expect(f.session.getSnapshot().target?.context).toEqual({ kind: "draft", id: "second" });
  expect(f.session.getSnapshot().turns).toEqual([]);
  expect(f.calls).toEqual([]);
  f.session.close();
});
test("a draft uses its existing handler and retains a proposal for review", async () => {
  const f = fixture();
  await f.session.open({
    ...target,
    context: { kind: "draft", id: "draft-one" },
    answer: async (text) => ({ text: `Proposed: ${text}`, proposal: true }),
  });
  await f.session.submit("Keep billing at a checkpoint");
  expect(f.calls).toEqual(["speak", "play"]);
  expect(f.session.getSnapshot().turns[1]?.proposal).toBe(true);
  f.session.close();
});
test("a specialist can converse without a generic Velum model, with cancellation and no fallback", async () => {
  const f = fixture();
  f.api.voiceCapabilities = async () => ({ ...CAP, provider: null, conversation: false });
  let seen: AbortSignal | undefined, resolve!: (v: { text: string }) => void;
  await f.session.open({
    ...target,
    assistantName: "&Tutor",
    answer: (_text, signal) => {
      seen = signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  expect(f.session.getSnapshot().capabilities?.conversation).toBe(true);
  const pending = f.session.submit("Explain the proof");
  f.session.close();
  expect(seen?.aborted).toBe(true);
  resolve({ text: "This result is late" });
  await pending;
  expect(f.session.getSnapshot().turns).toEqual([]);
  expect(f.calls).toEqual([]);
});
test("uncertain provider outcome is not resent; transcript stays visible", async () => {
  const f = fixture();
  f.api.voiceReply = async () => {
    f.calls.push("reply");
    throw new VoiceRequestError("reconciliation_required", "Check Usage");
  };
  await f.session.open(target);
  await f.session.submit("Explain the cost");
  expect(f.session.getSnapshot().uncertain).toBe(true);
  await f.session.submit("Explain the cost");
  await f.session.begin();
  expect(f.calls).toEqual(["reply"]);
  expect(f.session.getSnapshot().turns[0]?.text).toBe("Explain the cost");
  f.session.close();
});
test("blocked playback reuses its audio without another synthesis call", async () => {
  const f = fixture();
  let play = 0;
  f.audio.play = async () => {
    if (play++ === 0) throw new Error("Playback blocked");
  };
  await f.session.open(target);
  await f.session.submit("Explain this quest");
  expect(f.session.getSnapshot().phase).toBe("error");
  expect(f.session.getSnapshot().canReplay).toBe(true);
  await f.session.replay();
  expect(f.calls).toEqual(["reply", "speak"]);
  expect(f.session.getSnapshot().phase).toBe("ready");
  f.session.close();
});
test("unavailable speech does not ask for the microphone or silently switch providers", async () => {
  const f = fixture();
  let captured = false;
  f.api.voiceCapabilities = async () => ({ ...CAP, provider: null });
  f.audio.record = async () => {
    captured = true;
    throw new Error("should not be called");
  };
  await f.session.open(target);
  await f.session.begin();
  await f.session.submit("Explain this quest");
  expect(captured).toBe(false);
  expect(f.calls).toEqual(["reply"]);
  f.session.close();
});
test("long narration preserves all text, stays bounded and never emits empty parts", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 10000 }), fc.integer({ min: 20, max: 300 }), (text, max) => {
      const chunks = speechChunks(text, max);
      expect(chunks.join("")).toBe(text.trim());
      expect(chunks.every((c) => c.length > 0 && c.length <= max)).toBe(true);
    }),
    { numRuns: 200 },
  );
  const emoji = speechChunks("🪼".repeat(2000), 301);
  expect(emoji.join("")).toBe("🪼".repeat(2000));
  expect(emoji.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
});

test("backgrounding an unopened session does not open a voice panel", () => {
  const f = fixture();
  f.session.stop();
  expect(f.session.getSnapshot().phase).toBe("closed");
});

test("recording deadline finishes exactly one turn", async () => {
  const f = fixture();
  f.api.voiceCapabilities = async () => ({ ...CAP, maxRecordingMs: 10 });
  await f.session.open(target);
  await f.session.begin();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Recording did not finish"));
    }, 2000);
    const unsubscribe = f.session.subscribe(() => {
      if (f.session.getSnapshot().phase === "ready") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
  expect(f.calls).toEqual(["transcribe", "reply", "speak", "play"]);
  f.session.close();
});
