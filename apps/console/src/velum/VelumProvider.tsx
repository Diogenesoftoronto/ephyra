// The workspace Velum companion: one conversation per account+workspace scope, explicit references to parts of the
// console, and a short selection mode. Normal clicks are never intercepted outside selection mode.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { referenceKey, type VelumReference, type VoiceContext } from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { VelumCompanion, type CompanionState } from "./companion.ts";
import { CompanionVoice } from "./voice.ts";
import type { VoiceAudio } from "../voice/audio.ts";
import "./velum.css";

export type Source = { ref: VelumReference; label: string; href: string | null; element: HTMLElement | null };
type Env = {
  companion: VelumCompanion;
  voice: CompanionVoice;
  context: VoiceContext;
  contextLabel: string;
  canSpend: boolean;
  /** Why sending is disabled, when it is. */
  readOnlyReason: string | null;
  open: boolean;
  setOpen(open: boolean, focus?: boolean): void;
  selecting: boolean;
  setSelecting(on: boolean): void;
  register(id: string, source: Source): () => void;
  /** Bring a chip's source into view, or navigate to it. Returns false when it cannot be found. */
  locate(sourceId: string | null, href: string | null): boolean;
  toggle(id: string): void;
  sourceOnPage(id: string | null): boolean;
  composerRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  invokerRef: React.MutableRefObject<HTMLElement | null>;
};
const VelumEnv = createContext<Env | null>(null);
export const useVelum = () => useContext(VelumEnv);
export function useCompanionState(): CompanionState | null {
  const env = useVelum();
  const empty = useRef<CompanionState | null>(null);
  return useSyncExternalStore(env?.companion.subscribe ?? (() => () => {}), env?.companion.getSnapshot ?? (() => empty.current));
}

const INTERACTIVE = "a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[contenteditable=true]";

export function VelumProvider({
  api, scope, context, contextLabel, canSpend, readOnlyReason = null, children, audio,
}: {
  api: Pick<ConsoleApi, "voiceReply" | "voiceCapabilities" | "transcribe" | "speak">;
  /** Account + workspace. A new scope is a new, empty conversation; late results from the old one are dropped. */
  scope: string;
  context: VoiceContext;
  contextLabel: string;
  canSpend: boolean;
  readOnlyReason?: string | null;
  children: ReactNode;
  audio?: VoiceAudio;
}) {
  const companion = useMemo(() => new VelumCompanion(scope, api), [scope, api]);
  const voice = useMemo(() => new CompanionVoice(api, audio), [scope, api, audio]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    companion.activate();
    return () => companion.dispose();
  }, [companion]);
  useEffect(() => () => voice.dispose(), [voice]);
  const [open, setOpenState] = useState(false);
  const [selecting, setSelectingState] = useState(false);
  const sources = useRef(new Map<string, Source>());
  const [version, setVersion] = useState(0);
  const pendingLocate = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const reduced = usePrefersReducedMotion();

  // Recording must stop when the page is hidden; an open companion never starts the microphone by itself.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") voice.cancel(); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [voice]);

  const setOpen = useCallback((next: boolean, focus = true) => {
    setOpenState(next);
    if (!next) {
      setSelectingState(false);
      if (voice.getSnapshot().phase !== "idle") voice.cancel();
      if (focus) requestAnimationFrame(() => invokerRef.current?.focus());
    } else {
      void voice.check();
      if (focus) requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [voice]);
  const setSelecting = useCallback((on: boolean) => {
    setSelectingState(on);
    if (on) setOpenState(true);
    else requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const register = useCallback((id: string, source: Source) => {
    sources.current.set(id, source);
    setVersion((v) => v + 1);
    if (pendingLocate.current === id && source.element) {
      pendingLocate.current = null;
      requestAnimationFrame(() => reveal(source.element!, reduced));
    }
    return () => {
      if (sources.current.get(id) === source) {
        sources.current.delete(id);
        setVersion((v) => v + 1);
      }
    };
  }, [reduced]);

  // Sources re-register when their revision or range changes; chips for the same source are marked changed.
  useEffect(() => {
    companion.reconcile(new Map([...sources.current].map(([id, s]) => [id, { ref: s.ref, label: s.label }])));
  }, [companion, version]);

  const toggle = useCallback((id: string) => {
    const s = sources.current.get(id);
    if (s) companion.toggle(s.ref, s.label, id, s.href);
  }, [companion]);

  const locate = useCallback((sourceId: string | null, href: string | null) => {
    const s = sourceId ? sources.current.get(sourceId) : undefined;
    if (s?.element?.isConnected) {
      reveal(s.element, reduced);
      return true;
    }
    if (href) {
      pendingLocate.current = sourceId;
      location.hash = href;
      return true;
    }
    return false;
  }, [reduced]);

  // Selection mode: a click on a referable region adds or removes it. Nested links and buttons keep working.
  useEffect(() => {
    if (!selecting) return;
    document.documentElement.classList.add("velum-selecting");
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".velum-panel")) return;
      const region = target.closest<HTMLElement>("[data-velum-source]");
      if (!region) return;
      if (target.closest(INTERACTIVE) && !target.closest(".velum-ref-action")) return;
      event.preventDefault();
      event.stopPropagation();
      toggle(region.dataset.velumSource!);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelecting(false);
      }
    };
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key);
    return () => {
      document.documentElement.classList.remove("velum-selecting");
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key);
    };
  }, [selecting, toggle, setSelecting]);

  const env: Env = {
    companion, voice, context, contextLabel, canSpend, readOnlyReason, open, setOpen, selecting, setSelecting, register, locate,
    toggle, sourceOnPage: (id) => Boolean(id && sources.current.get(id)?.element?.isConnected), composerRef, invokerRef,
  };
  return <VelumEnv.Provider value={env}>{children}</VelumEnv.Provider>;
}

function reveal(element: HTMLElement, reduced: boolean) {
  element.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  element.dataset.velumLocated = "";
  window.setTimeout(() => { delete element.dataset.velumLocated; }, 1600);
  element.querySelector<HTMLElement>(".velum-ref-action")?.focus({ preventScroll: true });
}

/**
 * A part of the console Velum can be told about. The action appears on hover, keyboard focus, selection mode and when
 * selected; it is a real button, so keyboard and screen-reader users have the same path as pointer selection.
 */
export function Referable({
  id, refData, label, href = null, children, className, as: As = "div",
}: {
  id: string;
  refData: VelumReference;
  label: string;
  href?: string | null;
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "section";
}) {
  const env = useVelum();
  const state = useCompanionState();
  const element = useRef<HTMLElement | null>(null);
  const key = referenceKey(refData);
  useEffect(() => {
    if (!env) return;
    return env.register(id, { ref: refData, label, href, element: element.current });
  }, [env?.register, id, key, label, href]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!env) return <>{children}</>;
  const chip = state?.chips.find((c) => c.sourceId === id);
  const selected = Boolean(chip);
  return (
    <As
      ref={element as never}
      className={["velum-ref", className].filter(Boolean).join(" ")}
      data-velum-source={id}
      data-velum-selected={selected ? "" : undefined}
      data-velum-stale={chip && chip.status !== "current" ? "" : undefined}
    >
      {children}
      <button
        type="button"
        className="velum-ref-action"
        aria-pressed={selected}
        aria-label={selected ? `Remove ${label} from the Velum conversation` : `Refer Velum to ${label}`}
        title={selected ? "Remove from the Velum conversation" : "Refer Velum to this"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          env.toggle(id);
        }}
      >
        <span aria-hidden="true">{selected ? "✓" : "+"}</span>
        <span className="velum-ref-action__text">{selected ? "In conversation" : "Velum"}</span>
      </button>
    </As>
  );
}
