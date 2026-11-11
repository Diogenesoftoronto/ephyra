// The loop: every quest the server holds, where each one is, and the one thing (if any) that needs a person.
// Nothing here is simulated. The board is polled from the server and every action is a real write.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { InvestigationQuestion } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, type ConsoleApi } from "../api.ts";
import { useApi } from "../app/ApiContext.tsx";
import { useLoop } from "../app/useLoop.ts";
import { ErrorState } from "../components/Load.tsx";
import { Skeleton } from "../kit.ts";
import { playFeedback } from "../lib/feedback.ts";
import { useMediaQuery } from "../lib/hooks.ts";
import { LoopScene, QuestGroups, sceneViews } from "../loop/board.tsx";
import { Inspector, type HoodTab } from "../loop/Inspector.tsx";
import { runNow, type LiveQuest } from "../loop/live.ts";
import { byAttention, journeyOf, lastOf, type QuestView } from "../loop/model.ts";
import { FleetSentence, NeedsYou, QuestDetail, proofLine } from "../loop/parts.tsx";

const typing = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]"));
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Why a write did not go through, in words a person can act on. Server text is shown as text. */
function explain(what: string, error: unknown): string {
  if (error instanceof UnknownWriteOutcome) return `The server did not confirm. Look at the quest again before you ${what} a second time.`;
  if (error instanceof ApiError) {
    if (error.status === 409) return "This quest moved on while you were looking. It has been refreshed. Look again before deciding.";
    if (error.status === 403) return error.detail ?? "You do not have permission to do that here.";
    return `Could not ${what}. ${error.detail ?? `The server answered ${error.status}.`}`;
  }
  return `Could not ${what}. The server could not be reached.`;
}

type Props = {
  /** A quest to open: its id or its short name, from the address. */
  questId?: string;
  canAct?: boolean;
  principal?: string;
  /** Overrides the API from context. Stories use it. */
  api?: ConsoleApi;
};

export function LoopPage({ questId, canAct = true, principal, api: given }: Props) {
  const fromContext = useApi();
  const api = given ?? fromContext;
  const [picked, setPicked] = useState<string | null>(questId ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hood, setHood] = useState(false);
  const [tab, setTab] = useState<HoodTab>("events");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState<string | null>(null);
  const narrow = useMediaQuery("(max-width: 720px)");
  const aside = useRef<HTMLElement>(null);
  const writing = useRef(false);
  const prefix = useRef(0);

  const loop = useLoop(api, { viewer: principal, selected: selectedId, transcripts: hood });
  const { board } = loop;
  const order = useMemo(() => [...board.views].sort(byAttention), [board]);
  const selected: LiveQuest | null = board.quests.find((quest) => quest.view.short === picked || quest.id === picked)
    ?? board.quests.find((quest) => quest.id === (board.fleet.focus ?? order[0]?.id)) ?? null;
  // The docked strip is for a quest that is waiting on this person. A quest that merely can be resumed is not that.
  const waiting = order.filter((view) => view.attention === "needs_you" && view.action !== null);
  const needs = board.quests.find((quest) => quest.id === waiting[0]?.id) ?? null;
  const steps = useMemo(() => (selected ? journeyOf(selected.events, selected.trail) : []), [selected]);
  const running = lastOf(loop.runs, (run) => run.status === "running" && run.trailId === selected?.id) ?? null;
  const now = running ? runNow(loop.runEvents(running.id)) : null;

  useEffect(() => { setSelectedId(selected?.id ?? null); }, [selected?.id]);

  // An announcement stays up while its write is still in flight, then leaves by itself.
  useEffect(() => {
    if (!toast || busy) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast, busy]);

  useEffect(() => {
    if (!dropping) return;
    const timer = setTimeout(() => setDropping(null), 5000);
    return () => clearTimeout(timer);
  }, [dropping]);

  const select = useCallback((id: string) => {
    setPicked(id);
    playFeedback("touch");
    const short = board.quests.find((quest) => quest.id === id)?.view.short;
    if (short) history.replaceState(null, "", `${location.pathname}${location.search}#/loop/${encodeURIComponent(short)}`);
    if (matchMedia("(max-width: 1100px)").matches) {
      const quiet = matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => aside.current?.scrollIntoView({ behavior: quiet ? "auto" : "smooth", block: "start" }));
    }
  }, [board]);

  /** One write at a time, each under its own operation key. The board is read again whatever the outcome. */
  const write = useCallback(async <T,>(what: string, doing: string, done: string | ((result: T) => string), work: (op: string) => Promise<T>) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    // Say so at once. The server may take a moment (an approval lands the change before it answers).
    setToast(doing);
    try {
      const result = await work(crypto.randomUUID());
      setToast(typeof done === "string" ? done : done(result));
    } catch (error) {
      setToast(explain(what, error));
    } finally {
      writing.current = false;
      setBusy(false);
      loop.refresh();
    }
  }, [loop.refresh]);

  const gateOf = useCallback((quest: QuestView) => {
    const action = quest.action;
    if (action?.kind === "decide") {
      const item = loop.inbox.find((entry) => entry.trailId === quest.id && entry.kind === "checkpoint" && entry.checkpoint === action.checkpoint);
      return item ? { checkpoint: action.checkpoint, bound: item.bound } : null;
    }
    if (action?.kind === "spend") {
      const item = loop.inbox.find((entry) => entry.trailId === quest.id && entry.kind === "spend");
      return item ? { checkpoint: "spend" as const, bound: item.bound } : null;
    }
    return null;
  }, [loop.inbox]);

  const act = useCallback((quest: QuestView) => {
    const action = quest.action;
    if (!action) return;
    if (!canAct) { setToast("You can follow this workspace but not change it."); return; }
    if (action.kind === "answer") {
      setPicked(quest.id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-answer] textarea")?.focus());
      return;
    }
    if (action.kind === "resume" || action.kind === "release") {
      const done = action.kind === "resume" ? `Resumed ${quest.short}.` : `Released ${quest.short}. It carries on by itself.`;
      void write(action.kind, action.kind === "resume" ? `Resuming ${quest.short}.` : `Releasing ${quest.short}.`, done,
        (op) => api.trailAction(quest.id, action.kind, {}, op));
      return;
    }
    const gate = gateOf(quest);
    if (!gate) { setToast("That request is no longer open. The board has been refreshed."); loop.refresh(); return; }
    playFeedback("connected");
    void write("approve", `Approving ${quest.short}.`,
      action.kind === "spend" ? `Approved the spend. ${quest.short} carries on.` : `Approved. ${quest.short} moves on by itself.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "approve" }, op));
  }, [api, canAct, gateOf, write, loop.refresh]);

  const revise = useCallback((quest: QuestView, note: string) => {
    const gate = gateOf(quest);
    if (!canAct || !gate) return;
    void write("send it back", `Sending ${quest.short} back.`,
      `Sent ${quest.short} back with your note. It becomes the next attempt's first observation.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "revise", note }, op));
  }, [api, canAct, gateOf, write]);

  // Dropping ends a quest, so it takes two presses.
  const drop = useCallback((quest: QuestView) => {
    const gate = gateOf(quest);
    if (!canAct || !gate) return;
    if (dropping !== quest.id) {
      setDropping(quest.id);
      setToast(`Drop ${quest.short}? Nothing lands and the quest ends. Press Drop again to confirm.`);
      return;
    }
    setDropping(null);
    void write("drop it", `Dropping ${quest.short}.`, `Dropped ${quest.short}. Nothing lands.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "reject" }, op));
  }, [api, canAct, dropping, gateOf, write]);

  const answer = useCallback((quest: QuestView, text: string) => {
    if (quest.action?.kind !== "answer") return;
    const question = quest.action.questionId;
    void write<InvestigationQuestion>("send your answer", `Sending your answer. It is checked before ${quest.short} carries on.`,
      (saved) => saved.status === "answered" ? `Answer accepted as evidence. ${quest.short} carries on by itself.`
        : `The check did not accept that answer as evidence, so ${quest.short} stays stopped.`,
      (op) => api.answerQuestion(quest.id, question, { text }, op));
  }, [api, write]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (document.querySelector("dialog:modal")) return;
      if (event.key === "Escape") {
        if (hood) { event.preventDefault(); setHood(false); }
        return;
      }
      if (typing(event.target)) return;
      // `g` then a letter belongs to the command menu (g i opens the inbox), so the letter is left alone.
      if (Date.now() - prefix.current < 900) { prefix.current = 0; return; }
      if (event.key.toLowerCase() === "g") { prefix.current = Date.now(); return; }
      const move = (by: number) => {
        if (!order.length) return;
        const at = order.findIndex((view) => view.id === selected?.id);
        select(order[(at + by + order.length) % order.length]!.id);
      };
      switch (event.key) {
        case "j": move(1); break;
        case "k": move(-1); break;
        // Two deliberate keys to approve: `a` brings you to the action, Enter presses it. Never one stray keystroke.
        case "a":
          if (!needs) return;
          setPicked(needs.id);
          requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-primary]")?.focus());
          break;
        case "i": if (selected) setHood((open) => !open); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, needs, hood, select]);

  // Closing the hood hands focus back to the control that opened it.
  const hoodWas = useRef(hood);
  useEffect(() => {
    if (hoodWas.current && !hood) document.querySelector<HTMLElement>("[data-open-hood]")?.focus();
    hoodWas.current = hood;
  }, [hood]);

  if (loop.status === "loading") return <Skeleton block />;
  if (loop.status === "error") return <ErrorState error={loop.error} onRetry={loop.refresh} />;

  const view = selected?.view ?? null;
  const scene = sceneViews(board.views);
  return (
    <div className="lp-page" data-loop-page data-busy={busy || undefined}>
      <div className="lp-board" data-layout="h">
        <div className="lp-board-main">
          <FleetSentence fleet={board.fleet} />
          {loop.error !== null && loop.heardAt !== null && (
            <p className="lp-board-note" data-tone="warn" data-stale>
              Lost contact with the server. This is what it last reported, at {clock(loop.heardAt)}. Trying again.
            </p>
          )}
          {needs && (
            <NeedsYou quest={needs.view} proof={proofLine(needs.events)} more={Math.max(0, waiting.length - 1)} onAct={act}
              onRevise={canAct ? revise : undefined} onDrop={canAct ? drop : undefined} />
          )}
          <LoopScene views={scene} selected={selected?.id} current={view?.stage.id} narrow={narrow} compact onSelect={select} />
          {board.quests.length === 0
            ? <p className="lp-board-note">No quests yet. Ephyra opens one by itself when a signal arrives from production.</p>
            : <QuestGroups views={board.views} selected={selected?.id} narrow={narrow} finished={5} onSelect={select} />}
        </div>
        <aside className="lp-board-aside" aria-label="Selected quest" ref={aside}>
          {selected && view ? (
            <QuestDetail quest={view} steps={steps} now={now} run={running} onInspect={() => setHood(true)}>
              {view.action?.kind === "answer" && canAct && <AnswerForm key={view.action.questionId} quest={view} busy={busy} onAnswer={answer} />}
              {view.attention !== "needs_you" && (view.action?.kind === "resume" || view.action?.kind === "release") && canAct && (
                <p className="lp-detail-act">
                  <button type="button" className="lp-quiet" data-quiet-action={view.action.kind} disabled={busy} onClick={() => act(view)}>
                    {view.action.label}
                  </button>
                </p>
              )}
            </QuestDetail>
          ) : <p className="lp-board-empty">Nothing to look at yet.</p>}
        </aside>
      </div>

      {hood && selected && (
        <Inspector tab={tab} onTab={setTab} onClose={() => setHood(false)}
          note={selected.effects === null ? "This server keeps no record of effects for this quest, so that tab is empty." : undefined}
          hood={{ view: selected.view, events: selected.events, effects: selected.effects ?? [], runs: loop.runs, runEvents: loop.runEvents }} />
      )}

      <div className="lp-toast" role="status" aria-live="polite" data-toast>{toast}</div>
    </div>
  );
}

/** The answer to a question that was addressed to this person. It is checked by the server before the quest resumes. */
function AnswerForm({ quest, busy, onAnswer }: { quest: QuestView; busy: boolean; onAnswer: (quest: QuestView, text: string) => void }) {
  const [text, setText] = useState("");
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) onAnswer(quest, text.trim());
  };
  return (
    <form className="lp-answer" data-answer onSubmit={send}>
      <label htmlFor={`answer-${quest.short}`}>Your answer</label>
      <textarea id={`answer-${quest.short}`} rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)}
        placeholder="A short, factual answer. It is checked before the quest carries on." />
      <button type="submit" className="lp-quiet" disabled={busy || !text.trim()}>Send answer</button>
    </form>
  );
}
