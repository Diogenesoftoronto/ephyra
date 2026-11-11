// The Velum companion surface: one assistant-ui thread and composer for typed and spoken turns, the references attached
// to the next message, and every unhappy path with its own recovery action.
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { formatMicrousd } from "../lib/format.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { MarkdownText } from "../assistant/MarkdownText.tsx";
import type { Chip, Turn } from "./companion.ts";
import { useCompanionState, useVelum } from "./VelumProvider.tsx";

function MicIcon({ sound = false }: { sound?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      {sound ? <><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="M17 8a6 6 0 0 1 0 8" /></>
        : <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>}
    </svg>
  );
}

/** The compact invocation in the workspace bar. Opening never starts recording. */
export function VelumInvoker() {
  const env = useVelum();
  const state = useCompanionState();
  if (!env) return null;
  const count = state?.chips.length ?? 0;
  return (
    <button
      type="button"
      ref={(el) => { env.invokerRef.current = el; }}
      className="velum-invoker"
      aria-expanded={env.open}
      aria-controls="velum-companion"
      onClick={() => env.setOpen(!env.open)}
    >
      <PersonaAvatar persona="velum" size={24} />
      <span className="velum-invoker__label">Ask Velum</span>
      {count > 0 && <span className="velum-invoker__count" aria-label={`${count} referenced`}>{count}</span>}
    </button>
  );
}

function ChipView({ chip }: { chip: Chip }) {
  const env = useVelum()!;
  const onPage = env.sourceOnPage(chip.sourceId);
  return (
    <li className="velum-chip" data-status={chip.status}>
      <button
        type="button"
        className="velum-chip__label"
        onClick={() => env.locate(chip.sourceId, chip.href)}
        disabled={!onPage && !chip.href}
        title={onPage ? "Show where this is" : chip.href ? "Go to this" : "Not on this page"}
      >
        <span className="velum-chip__kind">{chip.ref.kind === "trail" ? "quest" : chip.ref.kind}</span>
        <span className="velum-chip__name">{chip.label}</span>
        {chip.status === "changed" && <span className="velum-chip__flag">changed</span>}
        {chip.status === "missing" && <span className="velum-chip__flag">gone</span>}
      </button>
      {chip.status === "changed" && chip.latest && (
        <button type="button" className="velum-chip__act" onClick={() => env.companion.refresh(chip.key)}>
          Use latest
        </button>
      )}
      <button type="button" className="velum-chip__remove" aria-label={`Remove ${chip.label}`} onClick={() => env.companion.remove(chip.key)}>
        ×
      </button>
    </li>
  );
}

function TurnStatus({ turn }: { turn: Extract<Turn, { role: "user" }> }) {
  const env = useVelum()!;
  if (turn.status === "sent") return null;
  const title = {
    unconfirmed: "Not confirmed",
    "rate-limited": "Not sent: provider busy",
    refused: "Not sent",
    unavailable: "Velum is unavailable",
    failed: "No reply",
  }[turn.status];
  return (
    <div className="velum-turn-status" data-status={turn.status} role={turn.status === "unconfirmed" ? "alert" : "status"}>
      <strong>{title}.</strong> {turn.error}
      {turn.status === "unconfirmed" && (
        <div className="velum-turn-actions">
          <button type="button" className="ui-button ui-button--sm" onClick={() => void env.companion.checkSaved(turn.id)}>
            Check saved reply
          </button>
          <button type="button" className="ui-button ui-button--sm ui-button--ghost" onClick={() => env.companion.setAside(turn.id)}>
            Leave unresolved
          </button>
          <a className="ui-button ui-button--sm ui-button--ghost" href="#/usage">Open Usage</a>
        </div>
      )}
    </div>
  );
}

function UserMessage() {
  const env = useVelum()!;
  const state = useCompanionState()!;
  const id = useAuiState((s) => s.message.id);
  const turn = state.turns.find((t) => t.id === id);
  return (
    <MessagePrimitive.Root className="velum-msg velum-msg--user">
      <div className="velum-bubble">
        <MessagePrimitive.Parts components={{ Text: ({ text }) => <p>{text}</p> }} />
        {turn?.role === "user" && (
          <>
            {(turn.chips.length > 0 || turn.via === "spoken") && (
              <p className="velum-msg-meta">
                {turn.via === "spoken" && <span>Spoken, edited before sending</span>}
                {turn.chips.length > 0 && <span>Referred to: {turn.chips.map((c) => c.label).join(", ")}</span>}
                <span>On {turn.asked}</span>
              </p>
            )}
            <TurnStatus turn={turn} />
          </>
        )}
      </div>
      {turn?.role === "user" && turn.status !== "sent" && (
        <span className="sr-only">{env.companion.blocked?.id === turn.id ? "Sending is paused until this is checked." : ""}</span>
      )}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const env = useVelum()!;
  const state = useCompanionState()!;
  const voice = useSyncExternalStore(env.voice.subscribe, env.voice.getSnapshot);
  const id = useAuiState((s) => s.message.id);
  const turn = state.turns.find((t) => t.id === id);
  if (!turn || turn.role !== "assistant") return null;
  const speaking = voice.speaking === id;
  const saved = voice.saved.includes(id);
  return (
    <MessagePrimitive.Root className="velum-msg">
      <PersonaAvatar persona="velum" size={32} />
      <div className="velum-bubble">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        <p className="velum-msg-meta">
          {turn.references.length > 0 && <span>Read: {turn.references.map((r) => r.label).join(", ")}</span>}
          <span>{turn.engine ?? "Model identity not reported"} · {turn.costMicrousd === null ? "cost unknown" : formatMicrousd(turn.costMicrousd)}</span>
        </p>
        {voice.capabilities?.provider && (
          <div className="velum-turn-actions">
            {speaking ? (
              <button type="button" className="ui-button ui-button--sm" onClick={() => env.voice.cancel()}>Stop playback</button>
            ) : (
              <button type="button" className="ui-button ui-button--sm ui-button--ghost" disabled={voice.phase !== "idle" || env.voice.blocked}
                onClick={() => void env.voice.play(id, turn.text)}>
                <MicIcon sound /> {saved ? "Play saved reply" : "Read aloud"}
              </button>
            )}
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

const VOICE_STATUS: Record<string, string> = {
  checking: "Checking voice availability",
  requesting: "Waiting for microphone permission",
  listening: "Listening",
  transcribing: "Transcribing into the message box",
  synthesizing: "Preparing Velum's voice",
  speaking: "Velum is speaking",
};

function VoiceControls() {
  const env = useVelum()!;
  const voice = useSyncExternalStore(env.voice.subscribe, env.voice.getSnapshot);
  const aui = useAui();
  // Dictated words land in the same composer as editable text. They are never sent automatically.
  const insert = (text: string) => {
    const previous = aui.composer().getState().text.trimEnd();
    aui.composer().setText(previous ? `${previous} ${text}` : text);
    env.composerRef.current?.focus();
  };
  if (!voice.capabilities?.provider) return null;
  const listening = voice.phase === "listening";
  const busy = voice.phase === "requesting" || voice.phase === "transcribing";
  return (
    <>
      {listening ? (
        <button type="button" className="ui-button ui-button--primary velum-mic" data-live="" onClick={() => void env.voice.finish(insert)}
          style={{ "--level": voice.level } as CSSProperties}>
          <MicIcon /> Stop and transcribe
        </button>
      ) : (
        <button type="button" className="ui-button velum-mic" disabled={!env.canSpend || voice.phase !== "idle" || env.voice.blocked}
          aria-busy={busy || undefined} onClick={() => void env.voice.record(insert)}>
          <MicIcon /> {busy ? "…" : "Speak"}
        </button>
      )}
      {(listening || busy) && (
        <button type="button" className="ui-button ui-button--ghost" onClick={() => env.voice.cancel()}>Cancel</button>
      )}
    </>
  );
}

function VoiceLine() {
  const env = useVelum()!;
  const voice = useSyncExternalStore(env.voice.subscribe, env.voice.getSnapshot);
  const status = VOICE_STATUS[voice.phase];
  const issue = voice.issue;
  return (
    <>
      <p className="velum-voice-line" role="status" aria-live="polite">
        {status ? (
          <>
            <span
              className="velum-voice-dot"
              data-phase={voice.phase}
              style={{ "--level": voice.level } as CSSProperties}
              aria-hidden="true"
            />
            {status}
            {voice.phase === "listening" &&
              ` · ${Math.floor(voice.elapsedMs / 1000)}s of ${Math.round((voice.capabilities?.maxRecordingMs ?? 60000) / 1000)}s. Microphone on.`}
          </>
        ) : voice.capabilities && !voice.capabilities.provider ? (
          "Voice is not connected on this deployment. Typing works."
        ) : null}
      </p>
      {issue && (
        <div className="velum-voice-issue" data-kind={issue.kind} role="alert">
          <p>{issue.message}</p>
          <div className="velum-turn-actions">
            {issue.kind === "uncertain" ? (
              <>
                <a className="ui-button ui-button--sm" href="#/usage">
                  Check Usage
                </a>
                <button
                  type="button"
                  className="ui-button ui-button--sm ui-button--ghost"
                  onClick={() => env.voice.acknowledge()}
                >
                  I checked, continue
                </button>
              </>
            ) : issue.kind === "playback-blocked" ? (
              <button
                type="button"
                className="ui-button ui-button--sm"
                onClick={() => {
                  const turn = env.companion.getSnapshot().turns.find((t) => t.id === issue.replyId);
                  if (turn) void env.voice.play(issue.replyId, turn.text);
                }}
              >
                Play saved reply
              </button>
            ) : (
              <button
                type="button"
                className="ui-button ui-button--sm ui-button--ghost"
                onClick={() => env.voice.dismiss()}
              >
                {issue.kind === "microphone" ? "Keep typing" : "Dismiss"}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The companion: a rail on wide screens, a sheet on phones. Kept mounted while closed so the draft and thread persist. */
export function CompanionPanel() {
  const env = useVelum();
  const state = useCompanionState();
  const hintId = useId();
  const panel = useRef<HTMLElement>(null);
  const messages = useMemo<ThreadMessageLike[]>(() => (state?.turns ?? []).map((t) => ({
    id: t.id, role: t.role, content: [{ type: "text", text: t.text }],
    ...(t.role === "assistant" ? { status: { type: "complete", reason: "stop" } } : {}),
  })), [state?.turns]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: Boolean(state?.sending),
    isDisabled: !env?.canSpend,
    convertMessage: (m) => m,
    onNew: async (message) => {
      if (!env) return;
      const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const outcome = await env.companion.send(text, env.context, env.contextLabel);
      if (outcome.kind === "kept" && !runtime.thread.composer.getState().text.trim()) runtime.thread.composer.setText(outcome.text);
    },
    onCancel: async () => env?.companion.stop(),
  });
  useEffect(() => {
    if (!env?.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || env.selecting || !panel.current?.contains(document.activeElement)) return;
      const phase = env.voice.getSnapshot().phase;
      event.preventDefault();
      if (phase === "listening" || phase === "requesting") env.voice.cancel();
      else env.setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [env, env?.open, env?.selecting]);
  if (!env || !state) return null;
  const chips = state.chips;
  const blocked = env.companion.blocked;
  const staleChips = chips.filter((c) => c.status !== "current");
  return (
    <aside
      ref={panel}
      id="velum-companion"
      className="velum-panel"
      data-open={env.open ? "" : undefined}
      data-selecting={env.selecting ? "" : undefined}
      hidden={!env.open}
      aria-label="Velum"
    >
      <header className="velum-head">
        <PersonaAvatar persona="velum" size={32} />
        <div>
          <h2>Velum</h2>
          <p>
            Looking at {env.contextLabel}.{" "}
            <span className="velum-capability">Velum reads recorded data and cannot approve or change anything.</span>
          </p>
        </div>
        <button
          type="button"
          className="ui-button ui-button--ghost ui-button--sm velum-close"
          onClick={() => env.setOpen(false)}
        >
          Close
        </button>
      </header>
      {env.selecting && (
        <div className="velum-selecting-bar" role="status" id={hintId}>
          <p>
            <strong>Choose an area, quest, or chart.</strong> Esc to finish.
            {chips.length > 0
              ? ` ${chips.length} selected: ${chips.map((c) => c.label).join(", ")}.`
              : " Nothing selected yet."}
          </p>
          <button
            type="button"
            className="ui-button ui-button--sm ui-button--primary"
            onClick={() => env.setSelecting(false)}
          >
            Done
          </button>
        </div>
      )}
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="velum-thread">
          <ThreadPrimitive.Viewport className="velum-viewport" aria-label="Conversation with Velum" tabIndex={0}>
            <ThreadPrimitive.Empty>
              <div className="velum-empty">
                <p>Ask about recorded work, spend, evidence or policy on any page.</p>
                <p className="muted">
                  Use <strong>Refer to something</strong> to point at an area, quest, run or chart. Your message lists
                  the records Velum reads.
                </p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            {state.sending && (
              <p className="velum-thinking" role="status">
                <span className="velum-voice-dot" data-phase="thinking" aria-hidden="true" /> Velum is reading and
                answering…{" "}
                <button
                  type="button"
                  className="ui-button ui-button--sm ui-button--ghost"
                  onClick={() => env.companion.stop()}
                >
                  Stop waiting
                </button>
              </p>
            )}
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="velum-composer">
            {state.notice && (
              <p className="velum-notice" role="status">
                {state.notice}
              </p>
            )}
            {chips.length > 0 && (
              <div className="velum-chips-wrap">
                <p className="velum-chips-title">
                  Velum will see {chips.length === 1 ? "this" : `these ${chips.length}`}
                  <button type="button" className="velum-link" onClick={() => env.companion.clear()}>
                    Clear all
                  </button>
                </p>
                <ul className="velum-chips" aria-label="Referenced in your next message">
                  {chips.map((c) => (
                    <ChipView key={c.key} chip={c} />
                  ))}
                </ul>
                {staleChips.length > 0 && (
                  <p className="velum-notice">Changed items are not sent. Use the latest version or remove them.</p>
                )}
              </div>
            )}
            <label className="velum-composer-label" htmlFor="velum-input">
              Message Velum
            </label>
            <ComposerPrimitive.Input
              id="velum-input"
              ref={(el) => {
                env.composerRef.current = el;
              }}
              rows={2}
              maxLength={6000}
              submitMode="enter"
              placeholder={env.canSpend ? "Ask about this page, or refer to something" : "Read only"}
              aria-describedby={env.selecting ? hintId : undefined}
            />
            <p className="velum-composer-hint">
              {!env.canSpend
                ? (env.readOnlyReason ??
                  "Only approvers can use this workspace's models. You can still read the conversation.")
                : blocked
                  ? "Sending is paused until the unconfirmed message is checked or left unresolved. You can keep editing."
                  : "Enter sends. Shift+Enter adds a line. Selecting things never sends or spends."}
            </p>
            <div className="velum-composer-row">
              <button
                type="button"
                className="ui-button velum-refer"
                aria-pressed={env.selecting}
                onClick={() => env.setSelecting(!env.selecting)}
              >
                {env.selecting ? "Done choosing" : "Refer to something"}
              </button>
              <VoiceControls />
              <ComposerPrimitive.Send asChild>
                <button
                  type="button"
                  className="ui-button ui-button--primary velum-send"
                  disabled={!env.canSpend || Boolean(blocked) || staleChips.length > 0}
                >
                  Send
                </button>
              </ComposerPrimitive.Send>
            </div>
            <VoiceLine />
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </aside>
  );
}
