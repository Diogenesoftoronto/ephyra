import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import type { VoiceAudioInput, VoiceCapabilities, VoiceReceipt, VoiceReplyInput } from "@ephyra/core";
import { ApiProvider } from "../app/ApiContext.tsx";
import { FakeApi } from "../fake/api.ts";
import { DraftPage } from "../pages/DraftPage.tsx";
import { DictateButton, ReadAloudButton, VoiceLauncher, VoiceProvider, VoiceSurface } from "./Voice.tsx";
import type { VoiceAudio } from "./audio.ts";
import type { VoiceState } from "./session.ts";

const meta: Meta = { title: "Voice/Conversation" };
export default meta;
const cap: VoiceCapabilities = {
  provider: "compatible",
  transcriptionModel: "fixture-stt",
  speechModel: "fixture-tts",
  voice: "fixture-voice",
  conversation: true,
  maxRecordingMs: 60000,
  maxAudioBytes: 4000000,
  maxSpeechChars: 3000,
  maxCostMicrousd: null,
};
const receipt = (operationKey: string): VoiceReceipt => ({
  operationKey,
  engine: "fixture-only",
  requestedModel: "fixture",
  tokens: null,
  costMicrousd: null,
  billedTo: "local",
});
const base: VoiceState = {
  phase: "ready",
  target: { context: { kind: "overview" }, mode: "talk", label: "Application overview" },
  capabilities: cap,
  turns: [],
  receipts: [],
  level: 0,
  elapsed: 0,
  error: null,
  uncertain: false,
  notice: null,
  transcript: "",
  canReplay: false,
  part: 0,
  parts: 0,
};
const conversation: VoiceState["turns"] = [
  { id: 1, role: "user", text: "What needs my attention before checkout can land?" },
  {
    id: 2,
    role: "assistant",
    text: "The checkout quest is waiting at checkpoint C. Its recorded tests passed, but the production watch has not run yet. " +
      "Open the proof to review what was tested before you decide.",
  },
];
const noop = () => {};
// A quarter-second of silence, for exercising the real Web Audio decoder without a paid speech call.
function silentWav() {
  const bytes = new Uint8Array(44 + 4000 * 2);
  const view = new DataView(bytes.buffer);
  const word = (at: number, text: string) => {
    [...text].forEach((ch, i) => {
      bytes[at + i] = ch.charCodeAt(0);
    });
  };
  word(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  word(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, 8000, true);
  return btoa(String.fromCharCode(...bytes));
}
const actions = {
  close: noop,
  stop: noop,
  begin: async () => {},
  finish: async () => {},
  submit: async () => {},
  insert: noop,
  replay: async () => {},
};
function Specimen({ patch = {} }: { patch?: Partial<VoiceState> }) {
  return (
    <div style={{ maxWidth: 600 }}>
      <p className="muted">Story fixture. No microphone or provider call.</p>
      <VoiceSurface state={{ ...base, ...patch }} session={actions} />
    </div>
  );
}
export const Ready: StoryObj = { render: () => <Specimen /> };
export const Loading: StoryObj = { render: () => <Specimen patch={{ phase: "loading", capabilities: null }} /> };
export const Listening: StoryObj = {
  render: () => <Specimen patch={{ phase: "listening", level: 0.42, elapsed: 6500 }} />,
};
export const WaitingForPermission: StoryObj = { render: () => <Specimen patch={{ phase: "requesting" }} /> };
export const Transcribing: StoryObj = { render: () => <Specimen patch={{ phase: "transcribing" }} /> };
export const Thinking: StoryObj = {
  render: () => <Specimen patch={{ phase: "thinking", turns: conversation.slice(0, 1) }} />,
};
export const Speaking: StoryObj = {
  render: () => (
    <Specimen patch={{ phase: "speaking", turns: conversation, level: 0.35, receipts: [receipt("1"), receipt("2")] }} />
  ),
};
export const DraftProposal: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        turns: [
          {
            id: 1,
            role: "assistant",
            text: "I drafted a billing area with a checkpoint before landing. Review the proposal beside your document.",
            proposal: true,
          },
        ],
        target: { context: { kind: "draft", id: "d-1" }, mode: "talk", label: "autonomy.md" },
      }}
    />
  ),
};
export const DictationReview: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        phase: "review",
        transcript: "Payments should always wait for me.",
        target: { ...base.target!, mode: "dictate" },
      }}
    />
  ),
};
export const MicrophoneDenied: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        phase: "error",
        error: "Microphone access is blocked. Allow it in your browser's site settings, or type your message.",
      }}
    />
  ),
};
export const SpeechUnavailable: StoryObj = {
  render: () => (
    <Specimen
      patch={{ capabilities: { ...cap, provider: null, speechModel: null, transcriptionModel: null, voice: null } }}
    />
  ),
};
export const UncertainCharge: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        phase: "error",
        uncertain: true,
        turns: conversation.slice(0, 1),
        error: "The speech request was interrupted. Its charge is unknown; check Usage before trying again.",
      }}
    />
  ),
};
export const PlaybackBlocked: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        phase: "error",
        turns: conversation,
        canReplay: true,
        error: "Your browser paused audio. Select Play reply to hear it.",
      }}
    />
  ),
};
export const LongNarration: StoryObj = {
  render: () => (
    <Specimen
      patch={{
        phase: "speaking",
        turns: conversation.slice(1),
        part: 2,
        parts: 3,
        target: { ...base.target!, mode: "read", label: "hypothesis.md" },
        level: 0.25,
      }}
    />
  ),
};
export const Dark: StoryObj = { ...Speaking, parameters: { theme: "dark" } };

class StoryVoiceApi extends FakeApi {
  constructor(private event: (name: string) => void) {
    super({ seedConversation: false });
  }
  override async voiceCapabilities() {
    return cap;
  }
  override async transcribe(_input: VoiceAudioInput, op: string, _signal: AbortSignal) {
    this.event("transcribe");
    return { text: "Add an area for billing.", receipt: receipt(op) };
  }
  override async voiceReply(_input: VoiceReplyInput, op: string, _signal: AbortSignal) {
    this.event("reply");
    return { text: conversation[1]!.text, contextLabel: "Fixture overview", receipt: receipt(op) };
  }
  override async speak(_text: string, op: string, _signal: AbortSignal) {
    this.event("speak");
    return { audio: silentWav(), mime: "audio/wav", receipt: receipt(op) };
  }
}

function Interactive({
  draft = false,
  readOnly = false,
  device = false,
}: {
  draft?: boolean;
  readOnly?: boolean;
  device?: boolean;
}) {
  const [calls, setCalls] = useState<string[]>([]);
  const [text, setText] = useState("Existing words.");
  const api = useMemo(() => new StoryVoiceApi((name) => setCalls((old) => [...old, name])), []);
  const audio = useMemo<VoiceAudio>(
    () => ({
      prime: noop,
      stop: noop,
      dispose: noop,
      record: async (level) => {
        level(0.3);
        return {
          stop: async () => {
            level(0);
            return new Blob(["fixture"], { type: "audio/webm" });
          },
          cancel: () => level(0),
        };
      },
      play: async (_clip, level, signal) => {
        level(0.25);
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
        level(0);
      },
    }),
    [],
  );
  return (
    <ApiProvider api={api}>
      <VoiceProvider
        api={api}
        audio={device ? undefined : audio}
        context={draft ? { kind: "draft", id: "d-1" } : { kind: "overview" }}
        label={draft ? "autonomy.md" : "Application overview"}
        scopeKey={draft ? "draft" : "overview"}
        canSpend={!readOnly}
      >
        <p className="muted">
          {device
            ? "Browser audio fixture. Recording uses your microphone; transcription is fixed and playback is a silent WAV. No audio leaves this page."
            : "Interactive fixture. Capture, transcripts and playback are simulated; no audio leaves this page."}
        </p>
        <output aria-label="Fixture requests">{calls.join(", ") || "No requests"}</output>
        {draft ? (
          <DraftPage draftId="d-1" canPublish={!readOnly} />
        ) : (
          <div className="stack">
            <VoiceLauncher />
            <label>
              Message draft
              <textarea aria-label="Message draft" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <DictateButton onText={(value) => setText((old) => `${old} ${value}`)} />
            <ReadAloudButton text="The proof is unavailable." label="fixture evidence" />
          </div>
        )}
      </VoiceProvider>
    </ApiProvider>
  );
}
export const InteractiveConversation: StoryObj = { render: () => <Interactive /> };
export const InteractiveDraft: StoryObj = { render: () => <Interactive draft /> };
export const ReadOnlyControls: StoryObj = { render: () => <Interactive readOnly /> };
export const BrowserAudio: StoryObj = { render: () => <Interactive device /> };
