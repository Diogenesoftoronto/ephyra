import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { referenceKey } from "@ephyra/core";
import { useCompanionState, useVelum } from "../velum/VelumProvider.tsx";
import "./WorkspaceAsk.css";

const KEY = "ephyra.workspace-ask";
const read = () => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const keep = (text: string) => { try { if (text) sessionStorage.setItem(KEY, text); else sessionStorage.removeItem(KEY); } catch { /* memory only */ } };

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
          runtime.thread.composer.setText(text);
        }
        return;
      }
      if (!env) return;
      env.setOpen(true, false);
      const outcome = await env.companion.send(text, env.context, "Workspace map");
      keep("");
      if (outcome.kind === "kept") runtime.thread.composer.setText(outcome.text);
    },
  });
  // Restore unsent words after navigation (this tab only).
  useEffect(() => { const saved = read(); if (saved) runtime.thread.composer.setText(saved); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const disabled = mode === "draft" ? !canDraft : !env?.canSpend;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root className="ws-ask">
        <div className="ws-ask__modes" role="radiogroup" aria-label="What should Velum do">
          <button type="button" role="radio" aria-checked={mode === "ask"} onClick={() => setMode("ask")}>Ask about the map</button>
          <button type="button" role="radio" aria-checked={mode === "draft"} onClick={() => setMode("draft")}>Draft a policy change</button>
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
          placeholder={mode === "ask" ? "e.g. Why can the marketing site land on its own?" : "e.g. Payments should never land without me."}
        />
        <div className="ws-ask__context" aria-live="polite">
          {areas.length > 0 ? (
            <p>
              {mode === "ask" ? "Velum will read" : "Your message will name"}{" "}
              {areas.map((a) => (
                <span key={referenceKey(a.ref)} className="ws-ask__area">{a.label}</span>
              ))}
              <button type="button" className="velum-link" onClick={() => areas.forEach((a) => env?.companion.remove(a.key))}>Clear</button>
            </p>
          ) : (
            <p className="muted">Select <strong>Velum</strong> on an area, or <button type="button" className="velum-link"
              onClick={() => env?.setSelecting(true)}>choose areas</button>, to talk about specific parts.</p>
          )}
          <p className="muted">
            {mode === "ask" ? "Answers use recorded policy and data. Velum cannot change anything from here."
              : "Opens the autonomy.md draft. Velum proposes; you review the change before publishing."}
          </p>
        </div>
        <div className="ws-ask__row">
          <ComposerPrimitive.Send asChild>
            <button type="button" className="ui-button ui-button--primary" disabled={disabled || busy}>
              {busy ? "Opening draft…" : mode === "ask" ? "Ask Velum" : "Draft with Velum"}
            </button>
          </ComposerPrimitive.Send>
          {disabled && <span className="muted">{mode === "draft" ? "Only approvers can start drafts." : "Only approvers can use this workspace's models."}</span>}
        </div>
        {failure && (
          <p role="alert" className="ws-ask__failure"><strong>{failure.title}.</strong> {failure.body} Your words are still in the box.</p>
        )}
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
