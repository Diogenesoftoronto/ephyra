// Voice for the workspace companion: record a turn, transcribe it into the SAME composer as editable text, and play a
// reply aloud on request. It never sends a message and never records without a user gesture. Each provider request has
// its own stable key; an unknown outcome is kept with its key and the same audio is not transcribed again.
import { VOICE_MAX_SPEECH_CHARS, type VoiceCapabilities, type VoiceSpeech } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, VoiceRequestError, type ConsoleApi } from "../api.ts";
import { BrowserVoiceAudio, microphoneError, recordingInput, type Recording, type VoiceAudio } from "../voice/audio.ts";
import { speechChunks } from "../voice/session.ts";

export type VoicePhase = "idle" | "checking" | "requesting" | "listening" | "transcribing" | "synthesizing" | "speaking";
export type VoiceIssue =
  | { kind: "microphone"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "rate-limited"; message: string; retryAfterSeconds?: number }
  | { kind: "uncertain"; message: string; operationKey: string; step: "transcribe" | "speak" }
  | { kind: "playback-blocked"; message: string; replyId: string }
  | { kind: "failed"; message: string };
export type CompanionVoiceState = {
  phase: VoicePhase;
  capabilities: VoiceCapabilities | null;
  /** Only actual microphone or playback samples; zero otherwise. */
  level: number;
  elapsedMs: number;
  issue: VoiceIssue | null;
  /** Reply being read aloud, and replies whose audio is saved for replay. */
  speaking: string | null;
  saved: readonly string[];
};
const IDLE: CompanionVoiceState = { phase: "idle", capabilities: null, level: 0, elapsedMs: 0, issue: null, speaking: null, saved: [] };

function issueFrom(error: unknown, operationKey: string, step: "transcribe" | "speak"): VoiceIssue {
  if (error instanceof UnknownWriteOutcome || (error instanceof VoiceRequestError && error.code === "reconciliation_required"))
    return { kind: "uncertain", operationKey, step, message: step === "transcribe"
      ? "The transcription may have finished and been billed, but no text came back. Check Usage; your typed text is unchanged."
      : "Velum's voice may have been generated and billed, but no audio came back. Check Usage before asking for audio again." };
  if (error instanceof VoiceRequestError && error.code === "rate_limited") return {
    kind: "rate-limited",
    message:
      error.retryAfterSeconds !== undefined
        ? `The speech provider asked to wait ${error.retryAfterSeconds} seconds. You can keep typing.`
        : "The speech provider is busy and did not say for how long. You can keep typing.",
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
  if (error instanceof ApiError && error.status === 429) return { kind: "rate-limited", message: "The speech provider is busy. You can keep typing." };
  if (error instanceof VoiceRequestError)
    return {
      kind:
        error.code === "unavailable" || error.code === "demo" || error.code === "voice_unavailable"
          ? "unavailable"
          : "failed",
      message: error.message,
    };
  return { kind: "microphone", message: microphoneError(error) };
}

export class CompanionVoice {
  private state: CompanionVoiceState = IDLE;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private recording: Recording | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private clips = new Map<string, VoiceSpeech[]>();
  private partialClips = new Map<string, { text: string; clips: VoiceSpeech[] }>();
  private inFlight: { operationKey: string; step: "transcribe" | "speak" } | null = null;
  constructor(
    private readonly api: Pick<ConsoleApi, "voiceCapabilities" | "transcribe" | "speak">,
    private readonly audio: VoiceAudio = new BrowserVoiceAudio(),
    private readonly opKey: () => string = () => `voice-${crypto.randomUUID()}`,
  ) {}
  subscribe = (f: () => void) => { this.listeners.add(f); return () => void this.listeners.delete(f); };
  getSnapshot = () => this.state;
  private set(patch: Partial<CompanionVoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const f of this.listeners) f();
  }
  private valid(g: number) { return g === this.generation; }
  private halt() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    if (this.clock) clearInterval(this.clock);
    if (this.deadline) clearTimeout(this.deadline);
    this.clock = this.deadline = null;
    this.recording?.cancel();
    this.recording = null;
    this.audio.stop();
  }
  /** Free capability check. Opening the companion calls this; it never touches the microphone. */
  async check() {
    if (this.state.capabilities || this.state.phase === "checking") return;
    const g = this.generation;
    this.set({ phase: "checking" });
    try {
      const capabilities = await this.api.voiceCapabilities();
      if (this.valid(g)) this.set({ capabilities, phase: "idle" });
    } catch {
      if (this.valid(g))
        this.set({
          phase: "idle",
          capabilities: null,
          issue: { kind: "unavailable", message: "Voice availability could not be checked. Typing still works." },
        });
    }
  }
  get blocked() { return this.state.issue?.kind === "uncertain"; }
  /** Must run from a click or key press: the browser asks for permission here. */
  async record(onText: (text: string) => void) {
    if (!this.state.capabilities?.provider || this.blocked || !["idle"].includes(this.state.phase)) return;
    this.halt();
    this.audio.prime();
    const g = this.generation;
    this.set({ phase: "requesting", issue: null, level: 0, elapsedMs: 0, speaking: null });
    try {
      const recording = await this.audio.record((level) => { if (this.valid(g)) this.set({ level }); }, this.abort.signal);
      if (!this.valid(g)) { recording.cancel(); return; }
      this.recording = recording;
      this.set({ phase: "listening" });
      const started = Date.now();
      this.clock = setInterval(() => this.set({ elapsedMs: Date.now() - started }), 250);
      this.deadline = setTimeout(() => void this.finish(onText), this.state.capabilities!.maxRecordingMs);
    } catch (error) {
      if (this.valid(g)) { this.halt(); this.set({ phase: "idle", level: 0, issue: issueFrom(error, "", "transcribe") }); }
    }
  }
  /** Stop listening and transcribe. The text goes into the composer for editing; nothing is sent. */
  async finish(onText: (text: string) => void) {
    if (this.state.phase !== "listening" || !this.recording) return;
    const recording = this.recording;
    this.recording = null;
    if (this.clock) clearInterval(this.clock);
    if (this.deadline) clearTimeout(this.deadline);
    this.clock = this.deadline = null;
    const g = this.generation;
    const key = this.opKey();
    this.set({ phase: "transcribing", level: 0 });
    try {
      const input = await recordingInput(await recording.stop());
      if (!this.valid(g)) return;
      this.inFlight = { operationKey: key, step: "transcribe" };
      const result = await this.api.transcribe(input, key, this.abort.signal);
      if (!this.valid(g)) return;
      this.set({ phase: "idle" });
      if (!result.text.trim()) this.set({ issue: { kind: "failed", message: "No speech was detected. Record again or type your message." } });
      else onText(result.text.trim());
    } catch (error) {
      if (this.valid(g)) this.set({ phase: "idle", issue: issueFrom(error, key, "transcribe") });
    } finally {
      if (this.valid(g)) this.inFlight = null;
    }
  }
  /** Cancel: input stops at once. A transcription already sent is reported as unconfirmed, never forgotten. */
  cancel() {
    const pending = this.inFlight;
    this.inFlight = null;
    this.halt();
    if (pending)
      this.set({ phase: "idle", level: 0, speaking: null, issue: { kind: "uncertain", ...pending,
        message: pending.step === "transcribe"
          ? "You stopped waiting after the recording was sent. It may still be transcribed and billed. Check Usage; your typed text is unchanged."
          : "You stopped waiting after audio was requested. It may still be generated and billed. Check Usage before requesting audio again." } });
    else this.set({ phase: "idle", level: 0, speaking: null });
  }
  /** Read a reply aloud. Audio already generated for this reply is reused instead of generated again. */
  async play(replyId: string, text: string) {
    if (!this.state.capabilities?.provider || this.state.phase !== "idle" || this.blocked) return;
    this.halt();
    this.audio.prime();
    const g = this.generation;
    this.set({ speaking: replyId, issue: null });
    let clips = this.clips.get(replyId);
    let key = "";
    try {
      if (!clips) {
        const partial = this.partialClips.get(replyId);
        clips = partial?.text === text ? partial.clips : [];
        this.partialClips.set(replyId, { text, clips });
        const max = this.state.capabilities.maxSpeechChars ?? VOICE_MAX_SPEECH_CHARS;
        const parts = speechChunks(text, max);
        for (let i = clips.length; i < parts.length; i++) {
          key = this.opKey();
          this.set({ phase: "synthesizing" });
          this.inFlight = { operationKey: key, step: "speak" };
          const clip = await this.api.speak(parts[i]!, key, this.abort.signal);
          if (!this.valid(g)) return;
          this.inFlight = null;
          clips.push(clip);
        }
        this.clips.set(replyId, clips);
        this.partialClips.delete(replyId);
        this.set({ saved: [...this.state.saved, replyId] });
      }
      for (const clip of clips) {
        this.set({ phase: "speaking" });
        await this.audio.play(clip, (level) => { if (this.valid(g)) this.set({ level }); }, this.abort.signal);
        if (!this.valid(g)) return;
      }
      this.set({ phase: "idle", level: 0, speaking: null });
    } catch (error) {
      if (!this.valid(g)) return;
      const blocked = error instanceof DOMException && error.name === "NotAllowedError" && this.clips.has(replyId);
      this.set({ phase: "idle", level: 0, speaking: null, issue: blocked
        ? { kind: "playback-blocked", replyId, message: "The browser blocked playback. Select Play saved reply to try again; no new audio is generated." }
        : issueFrom(error, key, "speak") });
    } finally {
      if (this.valid(g)) this.inFlight = null;
    }
  }
  dismiss() { if (this.state.issue?.kind !== "uncertain") this.set({ issue: null }); }
  /** The person has checked Usage and wants to continue. The unresolved request stays in Usage. */
  acknowledge() { this.set({ issue: null }); }
  dispose() {
    this.halt();
    this.audio.dispose();
    this.listeners.clear();
  }
}
