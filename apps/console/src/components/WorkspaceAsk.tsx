import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { referenceKey } from "@ephyra/core";
import { useCompanionState, useVelum } from "../velum/VelumProvider.tsx";
import "./WorkspaceAsk.css";

const KEY = "ephyra.workspace-ask";
const read = (key: string | null) => { try { return key ? sessionStorage.getItem(key) ?? "" : ""; } catch { return ""; } };

/**
 * The map's composer, on the same assistant-ui composer as every Velum conversation. Two explicit paths:
 * "Ask about the map" goes to the read-only companion with the selected areas as references; "Draft a policy change"
 * goes to the autonomy.md draft conversation, where proposals are reviewed before anything is published.
 */
export function WorkspaceAsk({ canDraft, busy, onDraft, failure }: {
  canDraft: boolean;
  busy: boolean;
  /** Sends to the document draft. Rejects keep the text in the box. */
  onDraft: (text: string) => Promise<void>;
  failure?: { title: string; body: string } | null;
}) {
  const env = useVelum();
  const storageKey = env ? `${KEY}:${encodeURIComponent(env.companion.scope)}` : null;
  const keep = (text: string) => {
    if (!storageKey) return;
    try { if (text) sessionStorage.setItem(storageKey, text); else sessionStorage.removeItem(storageKey); } catch { /* memory only */ }
  };
  const state = useCompanionState();
  const [mode, setMode] = useState<"ask" | "draft">("ask");
  const areas = (state?.chips ?? []).filter((c) => c.ref.kind === "area");
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    isRunning: busy || Boolean(state?.sending),
    convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
      if (!text) return;
      if (mode === "draft") {
        const named = areas.length ? `About ${areas.map((a) => a.ref.kind === "area" ? a.ref.name : a.label).join(", ")}: ` : "";
        try {
          await onDraft(named + text);
          keep("");
        } catch {
          if (!runtime.thread.composer.getState().text.trim()) runtime.thread.composer.setText(text);
          keep(runtime.thread.composer.getState().text);
        }
        return;
      }
      if (!env) return;
      env.setOpen(true, false);
      const outcome = await env.companion.send(text, env.context, "Workspace map");
      if (outcome.kind === "kept" && !runtime.thread.composer.getState().text.trim()) runtime.thread.composer.setText(outcome.text);
      keep(runtime.thread.composer.getState().text);
    },
  });
  // Restore unsent words after navigation (this tab only).
  useEffect(() => { runtime.thread.composer.setText(read(storageKey)); }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const disabled = mode === "draft" ? !canDraft : !env?.canSpend;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root className="ws-ask">
        <div className="ws-ask__modes" role="radiogroup" aria-label="What should Velum do">
          {(["ask", "draft"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              tabIndex={mode === value ? 0 : -1}
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === "Home" ? "ask" : event.key === "End" ? "draft" : mode === "ask" ? "draft" : "ask";
                setMode(next);
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
                buttons?.[next === "ask" ? 0 : 1]?.focus();
              }}
            >
              {value === "ask" ? "Ask about the map" : "Draft a policy change"}
            </button>
          ))}
        </div>
        <label className="ws-ask__label" htmlFor="ws-ask-input">
          {mode === "ask" ? "Ask Velum" : "Describe the change"}
        </label>
        <ComposerPrimitive.Input
          id="ws-ask-input"
          rows={2}
          maxLength={2000}
          submitMode="enter"
          onChange={(e) => keep(e.currentTarget.value)}
          placeholder={
            mode === "ask"
              ? "e.g. Why can the marketing site land on its own?"
              : "e.g. Payments should never land without me."
          }
        />
        <div className="ws-ask__context" aria-live="polite">
          {areas.length > 0 ? (
            <p>
              {mode === "ask" ? "Velum will read" : "Your message will name"}{" "}
              {areas.map((a) => (
                <span key={referenceKey(a.ref)} className="ws-ask__area">
                  {a.label}
                </span>
              ))}
              <button
                type="button"
                className="velum-link"
                onClick={() => areas.forEach((a) => env?.companion.remove(a.key))}
              >
                Clear
              </button>
            </p>
          ) : (
            <p className="muted">
              Select <strong>Velum</strong> on an area, or{" "}
              <button type="button" className="velum-link" onClick={() => env?.setSelecting(true)}>
                choose areas
              </button>
              , to talk about specific parts.
            </p>
          )}
          <p className="muted">
            {mode === "ask"
              ? "Answers use recorded policy and data. Velum cannot change anything from here."
              : "Opens the autonomy.md draft. Velum proposes; you review the change before publishing."}
          </p>
        </div>
        <div className="ws-ask__row">
          <ComposerPrimitive.Send asChild>
            <button type="button" className="ui-button ui-button--primary" disabled={disabled || busy}>
              {busy ? "Opening draft…" : mode === "ask" ? "Ask Velum" : "Draft with Velum"}
            </button>
          </ComposerPrimitive.Send>
          {disabled && (
            <span className="muted">
              {mode === "draft"
                ? "Only approvers can start drafts."
                : "Only approvers can use this workspace's models."}
            </span>
          )}
        </div>
        {failure && (
          <p role="alert" className="ws-ask__failure">
            <strong>{failure.title}.</strong> {failure.body} Your words are still in the box.
          </p>
        )}
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
