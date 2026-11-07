import {
  VOICE_MAX_SPEECH_CHARS,
  type VoiceCapabilities,
  type VoiceContext,
  type VoiceMessage,
  type VoiceReceipt,
  type VoiceSpeech,
} from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import { UnknownWriteOutcome, VoiceRequestError } from "../api.ts";
import { BrowserVoiceAudio, microphoneError, recordingInput, type Recording, type VoiceAudio } from "./audio.ts";

export type VoicePhase =
  | "closed"
  | "loading"
  | "ready"
  | "requesting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "synthesizing"
  | "speaking"
  | "review"
  | "error";
export type VoiceTurn = VoiceMessage & { id: number; proposal?: boolean };
export type VoiceAnswer = { text: string; receipt?: VoiceReceipt; proposal?: boolean };
export type VoiceTarget = {
  context: VoiceContext;
  label: string;
  mode: "talk" | "dictate" | "read";
  assistantName?: string;
  answer?: (text: string, signal: AbortSignal) => Promise<VoiceAnswer>;
  insert?: (text: string) => void;
};
export type VoiceState = {
  phase: VoicePhase;
  target: VoiceTarget | null;
  capabilities: VoiceCapabilities | null;
  turns: readonly VoiceTurn[];
  receipts: readonly VoiceReceipt[];
  level: number;
  elapsed: number;
  error: string | null;
  uncertain: boolean;
  notice: string | null;
  transcript: string;
  canReplay: boolean;
  part: number;
  parts: number;
};
const EMPTY: VoiceState = {
  phase: "closed",
  target: null,
  capabilities: null,
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
const BUSY = new Set<VoicePhase>([
  "loading",
  "requesting",
  "listening",
  "transcribing",
  "thinking",
  "synthesizing",
  "speaking",
]);

/** Preserve all spoken text while keeping each provider request bounded. */
export function speechChunks(text: string, max = VOICE_MAX_SPEECH_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const part = rest.slice(0, max);
    const boundary = Math.max(part.lastIndexOf(". "), part.lastIndexOf("\n"), part.lastIndexOf(" "));
    let cut = boundary > max / 2 ? boundary + 1 : max;
    if (/^[\uD800-\uDBFF]$/.test(rest[cut - 1]!) && /^[\uDC00-\uDFFF]$/.test(rest[cut]!)) cut--;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Observable controller, independent of React. Each asynchronous task belongs to one generation and one document context. */
export class VoiceSession {
  private state: VoiceState = EMPTY;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private generation = 0;
  private recording: Recording | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private lastClip: VoiceSpeech | null = null;
  private pendingClip: VoiceSpeech | null = null;
  private queue: string[] = [];
  constructor(
    private readonly api: ConsoleApi,
    private readonly audio: VoiceAudio = new BrowserVoiceAudio(),
    private readonly operationKey = () => crypto.randomUUID(),
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const f of this.listeners) f();
  }
  private valid(g: number) {
    return g === this.generation && !this.abort.signal.aborted;
  }
  private clearClock() {
    if (this.clock) clearInterval(this.clock);
    if (this.deadline) clearTimeout(this.deadline);
    this.clock = this.deadline = null;
  }
  private cancel() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.clearClock();
    this.recording?.cancel();
    this.recording = null;
    this.audio.stop();
  }
  private fail(error: unknown, g: number) {
    if (!this.valid(g)) return;
    this.clearClock();
    this.recording?.cancel();
    this.recording = null;
    this.audio.stop();
    this.set({
      phase: "error",
      level: 0,
      error: microphoneError(error),
      uncertain:
        error instanceof UnknownWriteOutcome ||
        (error instanceof VoiceRequestError && error.code === "reconciliation_required"),
    });
  }
  private receipt(receipt?: VoiceReceipt) {
    if (receipt && !this.state.receipts.some((r) => r.operationKey === receipt.operationKey))
      this.set({ receipts: [...this.state.receipts, receipt] });
  }
  async open(target: VoiceTarget, readText?: string) {
    this.cancel();
    this.audio.prime();
    this.lastClip = this.pendingClip = null;
    this.queue = [];
    this.state = { ...EMPTY, target, phase: "loading" };
    this.set({});
    const g = this.generation;
    try {
      const capabilities = await this.api.voiceCapabilities();
      if (!this.valid(g)) return;
      this.set({
        capabilities: { ...capabilities, conversation: Boolean(target.answer) || capabilities.conversation },
        phase: "ready",
      });
      if (target.mode === "read" && readText) {
        this.set({ turns: [{ id: 1, role: "assistant", text: readText }] });
        if (capabilities.provider) await this.speakText(readText, g);
      }
    } catch (error) {
      this.fail(error, g);
    }
  }
  close() {
    this.cancel();
    this.audio.dispose();
    this.queue = [];
    this.lastClip = this.pendingClip = null;
    this.state = EMPTY;
    this.set({});
  }
  stop() {
    const phase = this.state.phase;
    if (phase === "closed") return;
    if (phase === "loading") {
      this.close();
      return;
    }
    const dispatched = ["transcribing", "thinking", "synthesizing"].includes(phase);
    this.cancel();
    this.queue = [];
    this.pendingClip = null;
    this.set({
      phase: "ready",
      level: 0,
      error: null,
      notice: dispatched ? "Stopped here. A request already sent may still finish and be billed. Check Usage." : null,
    });
  }
  async begin() {
    if (
      !this.state.capabilities?.provider ||
      this.state.uncertain ||
      !["ready", "error", "speaking", "review"].includes(this.state.phase)
    )
      return;
    this.cancel();
    this.queue = [];
    this.pendingClip = null;
    this.audio.prime();
    const g = this.generation;
    this.set({ phase: "requesting", error: null, notice: null, level: 0, elapsed: 0 });
    try {
      const recording = await this.audio.record((value) => {
        if (this.valid(g)) this.set({ level: value });
      }, this.abort.signal);
      if (!this.valid(g)) {
        recording.cancel();
        return;
      }
      this.recording = recording;
      this.set({ phase: "listening" });
      const started = Date.now();
      this.clock = setInterval(() => this.set({ elapsed: Date.now() - started }), 250);
      this.deadline = setTimeout(() => {
        void this.finish();
      }, this.state.capabilities!.maxRecordingMs);
    } catch (error) {
      this.fail(error, g);
    }
  }
  async finish() {
    if (this.state.phase !== "listening" || !this.recording) return;
    const g = this.generation;
    const recording = this.recording;
    this.recording = null;
    this.clearClock();
    this.set({ phase: "transcribing", level: 0 });
    try {
      const blob = await recording.stop();
      if (!this.valid(g)) return;
      const input = await recordingInput(blob);
      if (!this.valid(g)) return;
      const transcript = await this.api.transcribe(input, this.operationKey(), this.abort.signal);
      if (!this.valid(g)) return;
      this.receipt(transcript.receipt);
      if (!transcript.text.trim()) throw new Error("No speech was detected. Record a new turn, or type your message.");
      if (this.state.target?.mode === "dictate") this.set({ phase: "review", transcript: transcript.text });
      else await this.answer(transcript.text, g);
    } catch (error) {
      this.fail(error, g);
    }
  }
  insert(text: string) {
    if (this.state.phase !== "review" || !text.trim() || !this.state.target?.insert) return;
    this.state.target.insert(text.trim());
    this.close();
  }
  async submit(text: string) {
    if (
      !text.trim() ||
      text.length > 6000 ||
      BUSY.has(this.state.phase) ||
      this.state.uncertain ||
      !this.state.capabilities?.conversation
    )
      return;
    this.audio.prime();
    const g = this.generation;
    try {
      await this.answer(text.trim(), g);
    } catch (error) {
      this.fail(error, g);
    }
  }
  private async answer(text: string, g: number) {
    const target = this.state.target!;
    const turns = [...this.state.turns, { id: this.state.turns.length + 1, role: "user" as const, text }];
    this.set({ turns, phase: "thinking", error: null, notice: null, canReplay: false });
    this.lastClip = this.pendingClip = null;
    const answer = target.answer
      ? await target.answer(text, this.abort.signal)
      : await this.api.voiceReply(
          { context: target.context, messages: turns.slice(-20).map((t) => ({ role: t.role, text: t.text })) },
          this.operationKey(),
          this.abort.signal,
        );
    if (!this.valid(g)) return;
    this.receipt(answer.receipt);
    if ("contextLabel" in answer) this.set({ target: { ...target, label: answer.contextLabel } });
    this.set({
      turns: [
        ...turns,
        {
          id: turns.length + 1,
          role: "assistant",
          text: answer.text,
          ...("proposal" in answer && answer.proposal ? { proposal: true } : {}),
        },
      ],
    });
    if (this.state.capabilities?.provider) await this.speakText(answer.text, g);
    else this.set({ phase: "ready" });
  }
  private async speakText(text: string, g: number) {
    this.queue = speechChunks(text, this.state.capabilities?.maxSpeechChars ?? VOICE_MAX_SPEECH_CHARS);
    this.set({ part: 0, parts: this.queue.length });
    await this.playQueue(g);
  }
  private async playQueue(g: number) {
    while (this.valid(g) && (this.queue.length || this.pendingClip)) {
      if (!this.pendingClip) {
        const text = this.queue.shift()!;
        this.set({ phase: "synthesizing", part: this.state.part + 1 });
        const clip = await this.api.speak(text, this.operationKey(), this.abort.signal);
        if (!this.valid(g)) return;
        this.receipt(clip.receipt);
        this.lastClip = this.pendingClip = clip;
      }
      this.set({ phase: "speaking", canReplay: true });
      await this.audio.play(
        this.pendingClip,
        (value) => {
          if (this.valid(g)) this.set({ level: value });
        },
        this.abort.signal,
      );
      if (!this.valid(g)) return;
      this.pendingClip = null;
    }
    if (this.valid(g)) this.set({ phase: "ready", level: 0 });
  }
  async replay() {
    if (!this.lastClip || BUSY.has(this.state.phase)) return;
    this.audio.prime();
    this.pendingClip ??= this.lastClip;
    const g = this.generation;
    this.set({ error: null });
    try {
      await this.playQueue(g);
    } catch (error) {
      this.fail(error, g);
    }
  }
}
