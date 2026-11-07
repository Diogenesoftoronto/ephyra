import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { VoiceContext as Context } from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import { Button, Field, Notice, Skeleton } from "../kit.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { formatMicrousd, formatTotalCost } from "../lib/format.ts";
import { VoiceSession, type VoiceAnswer, type VoiceState, type VoiceTarget } from "./session.ts";
import type { VoiceAudio } from "./audio.ts";
import "./voice.css";

type DraftHost = { id: string; label: string; disabled: boolean; answer: (text: string) => Promise<VoiceAnswer> };
type Environment = {
  session: VoiceSession;
  canSpend: boolean;
  context: Context;
  label: string;
  draft: { current: DraftHost | null };
  talk(): void;
  dictate(insert: (text: string) => void, label?: string): void;
  read(text: string, label: string): void;
};
const VoiceEnvironment = createContext<Environment | null>(null);

export function VoiceProvider({
  api,
  context,
  label,
  scopeKey,
  canSpend,
  children,
  audio,
}: {
  api: ConsoleApi;
  context: Context;
  label: string;
  scopeKey: string;
  canSpend: boolean;
  children: ReactNode;
  audio?: VoiceAudio;
}) {
  const session = useMemo(() => new VoiceSession(api, audio), [api, audio]);
  const draft = useRef<DraftHost | null>(null);
  useEffect(() => () => session.close(), [session, scopeKey, canSpend]);
  useEffect(() => {
    const stop = () => session.close();
    // A hidden page cannot keep recording or unexpectedly speak when the operator returns.
    const hidden = () => {
      if (document.visibilityState === "hidden") session.stop();
    };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [session]);
  const environment: Environment = {
    session,
    canSpend,
    context,
    label,
    draft,
    talk() {
      if (!canSpend) return;
      const host = draft.current;
      if (host?.disabled) return;
      const target: VoiceTarget = { context, label: host?.label ?? label, mode: "talk" };
      if (context.kind === "draft") {
        if (!host || host.id !== context.id) return;
        const id = context.id;
        target.answer = (text) => {
          const current = draft.current;
          if (!current || current.id !== id || current.disabled)
            throw new Error("This document changed. Close voice and save or discard your edits before continuing.");
          return current.answer(text);
        };
      }
      void session.open(target);
    },
    dictate(insert, source = "Message Velum") {
      if (canSpend) void session.open({ context, label: source, mode: "dictate", insert });
    },
    read(text, source) {
      if (canSpend) void session.open({ context, label: source, mode: "read" }, text);
    },
  };
  return (
    <VoiceEnvironment.Provider value={environment}>
      {children}
      <VoiceDialog session={session} />
    </VoiceEnvironment.Provider>
  );
}

/** Keep the voice path on the same draft handler and dirty/read-only guards as the text conversation. */
export function useDraftVoice(host: DraftHost) {
  const voice = useContext(VoiceEnvironment);
  useEffect(() => {
    if (!voice) return;
    voice.draft.current = host;
    return () => {
      if (voice.draft.current === host) voice.draft.current = null;
    };
  }, [voice, host]);
}

function MicIcon({ sound = false }: { sound?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {sound ? (
        <>
          <path d="M4 10v4h4l5 4V6L8 10H4Z" />
          <path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" />
        </>
      ) : (
        <>
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
        </>
      )}
    </svg>
  );
}

export function VoiceLauncher({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const voice = useContext(VoiceEnvironment);
  if (!voice) return null;
  return (
    <Button
      variant={compact ? "secondary" : "primary"}
      size={compact ? "sm" : undefined}
      disabled={disabled || !voice.canSpend}
      onClick={() => voice.talk()}
      title={!voice.canSpend ? "Only approvers can use the deployment's models." : undefined}
    >
      <MicIcon />
      Talk with Velum
    </Button>
  );
}

export function DictateButton({
  onText,
  disabled,
  label,
}: {
  onText: (text: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const voice = useContext(VoiceEnvironment);
  if (!voice) return null;
  return (
    <Button size="sm" disabled={disabled || !voice.canSpend} onClick={() => voice.dictate(onText, label)}>
      <MicIcon />
      Dictate
    </Button>
  );
}

export function ReadAloudButton({ text, label }: { text: string; label: string }) {
  const voice = useContext(VoiceEnvironment);
  if (!voice || !text.trim()) return null;
  return (
    <Button
      size="sm"
      disabled={!voice.canSpend}
      onClick={() => voice.read(text, label)}
      aria-label={`Read ${label} aloud`}
    >
      <MicIcon sound />
      Read aloud
    </Button>
  );
}

/** Text-only specialists use the same capture and playback transport; the answer's model stays explicit. */
export function GuidedVoiceButton({
  name,
  label,
  answer,
  disabled,
}: {
  name: string;
  label: string;
  answer: NonNullable<VoiceTarget["answer"]>;
  disabled?: boolean;
}) {
  const voice = useContext(VoiceEnvironment);
  const latest = useRef(answer);
  latest.current = answer;
  const owned = useRef<VoiceTarget | null>(null);
  useEffect(
    () => () => {
      if (owned.current && voice?.session.getSnapshot().target === owned.current) voice.session.close();
    },
    [voice?.session, label],
  );
  if (!voice) return null;
  return (
    <Button
      size="sm"
      disabled={disabled || !voice.canSpend}
      onClick={() => {
        owned.current = {
          context: voice.context,
          label,
          mode: "talk",
          assistantName: name,
          answer: (text, signal) => latest.current(text, signal),
        };
        void voice.session.open(owned.current);
      }}
    >
      <MicIcon />
      Talk with {name}
    </Button>
  );
}

function VoiceDialog({ session }: { session: VoiceSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = state.phase !== "closed";
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="voice-dialog"
      aria-label={`Voice with ${state.target?.assistantName ?? "Velum"}`}
      onCancel={(event) => {
        event.preventDefault();
        session.close();
      }}
    >
      {open && <VoiceSurface state={state} session={session} />}
    </dialog>
  );
}

const PHASE: Record<VoiceState["phase"], string> = {
  closed: "",
  loading: "Checking voice availability",
  ready: "Your turn",
  requesting: "Waiting for microphone permission",
  listening: "Listening",
  transcribing: "Transcribing your words",
  thinking: "Velum is thinking",
  synthesizing: "Preparing Velum's voice",
  speaking: "Velum is speaking",
  review: "Review your words",
  error: "Voice needs your attention",
};
type Actions = Pick<VoiceSession, "close" | "stop" | "begin" | "finish" | "submit" | "insert" | "replay">;

/** The actual voice surface, also rendered directly in Storybook for every device/provider state. */
export function VoiceSurface({ state, session }: { state: VoiceState; session: Actions }) {
  const [typed, setTyped] = useState("");
  const [dictated, setDictated] = useState(state.transcript);
  const textId = useId();
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDictated(state.transcript);
  }, [state.transcript]);
  useEffect(() => {
    const el = captions.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.turns.length]);
  const cap = state.capabilities;
  const mode = state.target?.mode ?? "talk";
  const idle = ["ready", "error", "review"].includes(state.phase);
  const recording = state.phase === "listening";
  const speech = state.phase === "speaking";
  const canRecord = Boolean(cap?.provider) && (idle || speech) && !state.uncertain;
  const busy = !idle && state.phase !== "closed";
  const total = {
    costMicrousd: state.receipts.reduce((sum, r) => sum + (r.costMicrousd ?? 0), 0),
    unknownCost: state.receipts.filter((r) => r.costMicrousd === null).length,
  };
  const name = state.target?.assistantName ?? "Velum";
  const title = mode === "dictate" ? "Dictate a message" : mode === "read" ? "Listen with Velum" : `Talk with ${name}`;
  return (
    <section className="voice-surface" aria-label={title}>
      <header className="voice-heading">
        <div>
          <h2>{title}</h2>
          <p>{state.target?.label ?? "Application overview"}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => session.close()} aria-label="Close voice">
          Close
        </Button>
      </header>
      <div
        className="voice-presence"
        data-active={recording || speech}
        style={{ "--voice-level": Math.max(0, Math.min(1, state.level)) } as CSSProperties}
      >
        <div className="voice-persona">
          <PersonaAvatar persona="velum" size={96} />
        </div>
        <p className="voice-state" role="status">
          {state.phase === "thinking" ? `${name} is thinking` : PHASE[state.phase]}
          {recording
            ? ` · ${Math.floor(state.elapsed / 1000)}s / ${Math.round((cap?.maxRecordingMs ?? 60000) / 1000)}s`
            : ""}
        </p>
        {state.target?.assistantName && (
          <p className="muted">{name} supplies the explanation. Velum reads it aloud using your speech provider.</p>
        )}
        <div
          className="voice-level"
          role="meter"
          aria-label={speech ? "Playback level" : "Microphone level"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.level * 100)}
        >
          <span />
        </div>
        {state.parts > 1 && (
          <p className="muted">
            Part {state.part} of {state.parts}
          </p>
        )}
      </div>
      <div className="voice-body">
        {state.phase === "loading" && <Skeleton />}
        {cap && !cap.provider && (
          <Notice
            tone="warn"
            title="Speech is not connected"
            body={"This deployment has no speech provider. An operator can connect Not Organic or a compatible service. " +
              `You can still use the text conversation when ${name} is configured.`}
          />
        )}
        {state.error && (
          <Notice
            tone="warn"
            title={state.uncertain ? "The outcome is uncertain" : "Voice paused"}
            body={
              <>
                {state.error}
                {state.uncertain && (
                  <>
                    {" "}
                    <a href="#/usage" onClick={() => session.close()}>
                      Open Usage
                    </a>
                  </>
                )}
              </>
            }
          />
        )}
        {state.notice && (
          <p role="status" className="muted">
            {state.notice}
          </p>
        )}
        {!state.turns.length && mode === "talk" && (
          <div className="voice-start">
            <p>
              {state.target?.assistantName
                ? "Ask about this trail's evidence and what an approval permits. The explanation stays attached to this revision."
                : state.target?.context.kind === "draft"
                  ? "Describe what your application should do. Velum drafts the changes with you; proposals stay in the document conversation for review."
                  : "Talk through agent work, a proof, or what the application has spent. Velum reads the recorded context for this view."}
            </p>
            <p className="muted">
              Speak one turn at a time. Select Send turn when you finish, or interrupt a spoken reply to take over.
            </p>
          </div>
        )}
        {state.turns.length > 0 && (
          <div
            ref={captions}
            className="voice-captions"
            role="log"
            aria-label="Conversation captions"
            aria-live="polite"
          >
            {state.turns.map((turn) => (
              <article key={turn.id} data-speaker={turn.role}>
                <strong>{turn.role === "user" ? "You" : name}</strong>
                <p>{turn.text}</p>
                {turn.proposal && (
                  <p className="voice-proposal">
                    Proposal ready. Close voice to review it in the document conversation.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
        {mode === "dictate" && state.phase === "review" && (
          <Field
            label="Your words"
            hint="Edit this transcript before inserting it. Inserting does not send your message."
          >
            <textarea rows={5} value={dictated} onChange={(e) => setDictated(e.target.value)} maxLength={6000} />
          </Field>
        )}
        {mode === "dictate" && state.phase !== "review" && (
          <p>Your recording becomes editable text in the message box. Send the message when you are ready.</p>
        )}
        {mode === "talk" && (
          <form
            className="voice-text"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) {
                void session.submit(typed);
                setTyped("");
              }
            }}
          >
            <Field label={`Or type to ${name}`}>
              <textarea
                id={textId}
                rows={2}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                maxLength={6000}
                disabled={!idle || state.uncertain || !cap?.conversation}
                placeholder="What should I pay attention to?"
              />
            </Field>
            <Button type="submit" size="sm" disabled={!idle || state.uncertain || !typed.trim() || !cap?.conversation}>
              Send message
            </Button>
          </form>
        )}
      </div>
      <footer className="voice-footer">
        <div className="voice-controls">
          {mode !== "read" &&
            (recording ? (
              <Button variant="primary" onClick={() => void session.finish()}>
                <MicIcon />
                {mode === "dictate" ? "Transcribe" : "Send turn"}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!canRecord || (mode === "talk" && !cap?.conversation)}
                onClick={() => void session.begin()}
              >
                <MicIcon />
                {speech ? "Interrupt and speak" : "Start recording"}
              </Button>
            ))}
          {mode === "dictate" && state.phase === "review" && (
            <Button variant="primary" disabled={!dictated.trim()} onClick={() => session.insert(dictated)}>
              Insert text
            </Button>
          )}
          {busy && state.phase !== "loading" && (
            <Button onClick={() => session.stop()}>
              {speech ? "Stop playback" : recording ? "Cancel recording" : "Cancel request"}
            </Button>
          )}
          {idle && state.canReplay && (
            <Button onClick={() => void session.replay()}>
              <MicIcon sound />
              {state.parts > 1 ? "Play this part" : "Play reply"}
            </Button>
          )}
        </div>
        <p className="voice-disclosure">
          {recording ? "Microphone on. Audio is sent for transcription when you finish." : "Microphone off."}{" "}
          {mode !== "read" && "Captions stay visible."}
        </p>
        <details className="voice-account">
          <summary>Session usage{state.receipts.length > 0 ? ` · ${formatTotalCost(total)}` : ""}</summary>
          <p>
            Speech and replies use this deployment's configured models. Audio is temporary; document messages are saved
            with the draft.
          </p>
          {cap?.provider && (
            <p>
              Speech: {cap.provider}. Transcription: <code>{cap.transcriptionModel}</code>. Playback:{" "}
              <code>{cap.speechModel}</code>, voice <code>{cap.voice}</code>.
            </p>
          )}
          {cap?.maxCostMicrousd != null && (
            <p>
              Reservation ceiling per speech request: {formatMicrousd(cap.maxCostMicrousd)}. This is a ceiling, not a
              price.
            </p>
          )}
          {state.receipts.map((r) => (
            <p key={r.operationKey}>
              {r.engine ?? `Identity not reported (${r.requestedModel} requested)`} · {formatMicrousd(r.costMicrousd)}
            </p>
          ))}
          <a href="#/usage" onClick={() => session.close()}>
            View recorded usage
          </a>
        </details>
      </footer>
    </section>
  );
}
