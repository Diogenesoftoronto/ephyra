import { VOICE_MAX_AUDIO_BYTES, type VoiceAudioInput, type VoiceSpeech } from "@ephyra/core";

export type Recording = { stop(): Promise<Blob>; cancel(): void };
export interface VoiceAudio {
  prime(): void;
  record(level: (value: number) => void, signal: AbortSignal): Promise<Recording>;
  play(clip: VoiceSpeech, level: (value: number) => void, signal: AbortSignal): Promise<void>;
  stop(): void;
  dispose(): void;
}

export async function recordingInput(blob: Blob): Promise<VoiceAudioInput> {
  if (!blob.size) throw new Error("The recording was empty. Check your microphone and record again.");
  if (blob.size > VOICE_MAX_AUDIO_BYTES) throw new Error("This recording is too large. Record a shorter turn.");
  const mime = blob.type.split(";")[0] as VoiceAudioInput["mime"];
  if (!["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"].includes(mime))
    throw new Error("This browser recorded an unsupported audio format. You can keep typing.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { audio: btoa(binary), mime };
}

export function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError")
      return "Microphone access is blocked. Allow it in your browser's site settings, or type your message.";
    if (error.name === "NotFoundError") return "No microphone was found. Connect one, or type your message.";
    if (error.name === "NotReadableError")
      return "The microphone is busy or unavailable. Check other calls and your device settings.";
  }
  return error instanceof Error ? error.message : "The microphone is unavailable. You can keep typing.";
}

/** Owns capture and playback for one conversation. Levels come from actual audio, never an invented waveform. */
export class BrowserVoiceAudio implements VoiceAudio {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private finishPlayback: (() => void) | null = null;
  prime() {
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => undefined);
    } catch {
      /* The text path remains usable on devices without Web Audio. */
    }
  }
  private meter(node: AudioNode, level: (value: number) => void) {
    const context = this.context;
    if (!context) return () => level(0);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    node.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const tick = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
      level(Math.min(1, rms * 5));
    }, 80);
    return () => {
      clearInterval(tick);
      try {
        node.disconnect(analyser);
      } catch {}
      analyser.disconnect();
      level(0);
    };
  }
  async record(level: (value: number) => void, signal: AbortSignal): Promise<Recording> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      throw new Error("Recording needs a browser with microphone access over HTTPS or localhost. You can keep typing.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    const release = () => stream.getTracks().forEach((track) => track.stop());
    // Permission can arrive after the person left the view. Dispose it before constructing a recorder.
    if (signal.aborted) {
      release();
      throw new DOMException("Cancelled", "AbortError");
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    let recorder: MediaRecorder;
    let input: MediaStreamAudioSourceNode | null = null;
    let stopMeter = () => level(0);
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
      if (this.context && this.context.state !== "closed") {
        input = this.context.createMediaStreamSource(stream);
        stopMeter = this.meter(input, level);
      }
    } catch (error) {
      release();
      input?.disconnect();
      throw error;
    }
    const chunks: BlobPart[] = [];
    let size = 0;
    let cancelled = false;
    let failure: Error | null = null;
    let resolve!: (blob: Blob) => void;
    let reject!: (error: Error) => void;
    const stopped = new Promise<Blob>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // It may reject before stop() is called (device unplugged); keep it observed until the caller awaits it.
    void stopped.catch(() => undefined);
    const cleanup = () => {
      release();
      stopMeter();
      input?.disconnect();
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      cleanup();
    };
    recorder.ondataavailable = (event) => {
      if (cancelled) return;
      size += event.data.size;
      if (size > VOICE_MAX_AUDIO_BYTES) {
        failure = new Error("The recording is too large. Record a shorter turn.");
        cancel();
      } else chunks.push(event.data);
    };
    recorder.onerror = () => {
      failure = new Error("The microphone stopped recording. Check your device and try a new turn.");
      cancel();
      reject(failure);
    };
    recorder.onstop = () => {
      cleanup();
      if (failure) reject(failure);
      else resolve(cancelled ? new Blob() : new Blob(chunks, { type: recorder.mimeType }));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      recorder.start(250);
    } catch (error) {
      cleanup();
      throw error;
    }
    return {
      cancel,
      stop: () => {
        if (recorder.state !== "inactive") recorder.stop();
        release();
        return stopped;
      },
    };
  }
  async play(clip: VoiceSpeech, level: (value: number) => void, signal: AbortSignal): Promise<void> {
    this.stop();
    const context = this.context;
    if (!context || context.state !== "running")
      throw new Error("Your browser paused audio. Select Play reply to hear it.");
    const bytes = Uint8Array.from(atob(clip.audio), (ch) => ch.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    signal.throwIfAborted();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.source = source;
    const stopMeter = this.meter(source, level);
    await new Promise<void>((resolve) => {
      const done = () => {
        stopMeter();
        source.disconnect();
        signal.removeEventListener("abort", stop);
        if (this.source === source) {
          this.source = null;
          this.finishPlayback = null;
        }
        resolve();
      };
      const stop = () => {
        try {
          source.stop();
        } catch {}
        done();
      };
      this.finishPlayback = stop;
      source.onended = done;
      signal.addEventListener("abort", stop, { once: true });
      source.start();
    });
  }
  stop() {
    this.finishPlayback?.();
  }
  dispose() {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
