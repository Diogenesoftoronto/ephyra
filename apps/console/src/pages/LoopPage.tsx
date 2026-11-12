// The loop: every quest the server holds, where each one is, and the one thing (if any) that needs a person.
// Nothing here is simulated. The board is polled from the server and every action is a real write.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { InvestigationQuestion } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, type ConsoleApi } from "../api.ts";
import { useApi } from "../app/ApiContext.tsx";
import { useLoop } from "../app/useLoop.ts";
import { publishWaiting } from "../app/waiting.ts";
import { ErrorState } from "../components/Load.tsx";
import { Skeleton } from "../kit.ts";
import { playFeedback } from "../lib/feedback.ts";
import { useMediaQuery } from "../lib/hooks.ts";
import { LoopScene, QuestGroups, sceneViews } from "../loop/board.tsx";
import { Inspector, type HoodTab } from "../loop/Inspector.tsx";
import { pollDelay, runNow, type LiveQuest } from "../loop/live.ts";
import { byAttention, journeyOf, lastOf, watchProgress, type QuestView } from "../loop/model.ts";
import { FleetSentence, NeedsYou, QuestDetail, proofLine } from "../loop/parts.tsx";
import { Referable } from "../velum/VelumProvider.tsx";

const typing = (target: EventTarget | null) => target instanceof Element
  && Boolean(target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]"));
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Time left, in the unit a person would say it in. */
const left = (seconds: number) => (seconds < 90 ? `${Math.max(0, Math.ceil(seconds))} s`
  : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`);
const list = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "");

/** Why a write did not go through, in words a person can act on. Server text is shown as text. */
function explain(what: string, error: unknown): string {
  if (error instanceof UnknownWriteOutcome) {
    return `The server did not confirm, so this may or may not have happened. The board has been read again: check the quest before you ${what} a second time.`;
  }
  if (error instanceof ApiError) {
    if (error.status === 409) return "This quest moved on while you were looking. The board has been read again. Look at it before deciding.";
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
  /** False when this workspace has no repository: nothing is watched, so the board must not say production is quiet. */
  connected?: boolean;
};

export function LoopPage({ questId, canAct = true, principal, api: given, connected }: Props) {
  const fromContext = useApi();
  const api = given ?? fromContext;
  const [picked, setPicked] = useState<string | null>(questId ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hood, setHood] = useState(false);
  const [tab, setTab] = useState<HoodTab>("events");
  const [toast, setToast] = useState("");
  /** A write that did not go through. It stays on screen until it is dismissed or the next write succeeds. */
  const [problem, setProblem] = useState<{ text: string; quest?: string; was?: string; at: number } | null>(null);
  const fail = useCallback((text: string, about?: QuestView) => {
    setProblem({ text, quest: about?.id, was: about ? `${about.state}:${about.attention}` : undefined, at: Date.now() });
  }, []);
  const [busy, setBusy] = useState(false);
  const narrow = useMediaQuery("(max-width: 720px)");
  // Where there is room for the board and the machinery side by side, the hood is a column and the board stays usable.
  const roomy = useMediaQuery("(min-width: 1900px)");
  const aside = useRef<HTMLElement>(null);
  const writing = useRef(false);
  const prefix = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  const loop = useLoop(api, { viewer: principal, selected: selectedId, transcripts: hood });
  const { board } = loop;
  const order = useMemo(() => [...board.views].sort(byAttention), [board]);
  const selected: LiveQuest | null = board.quests.find((quest) => quest.view.short === picked || quest.id === picked)
    ?? board.quests.find((quest) => quest.id === (board.fleet.focus ?? order[0]?.id)) ?? null;
  // The docked strip is for a quest that is waiting on this person. A quest that merely can be resumed is not that.
  const waiting = order.filter((view) => view.attention === "needs_you" && view.action !== null);
  // When several wait, the strip shows the one you picked; otherwise the first in line. Still one action on the page.
  const front = waiting.find((view) => view.id === selected?.id) ?? waiting[0];
  const needs = board.quests.find((quest) => quest.id === front?.id) ?? null;
  const steps = useMemo(() => (selected ? journeyOf(selected.events, selected.trail) : []), [selected]);
  const running = lastOf(loop.runs, (run) => run.status === "running" && run.trailId === selected?.id) ?? null;
  const now = running ? runNow(loop.runEvents(running.id)) : null;

  useEffect(() => { setSelectedId(selected?.id ?? null); }, [selected?.id]);

  // The navigation's inbox badge counts what this page just heard, so the two cannot disagree.
  useEffect(() => {
    publishWaiting(loop.status === "ready" ? loop.inbox.filter((item) => item.kind === "checkpoint" || item.kind === "spend").length : null);
  }, [loop.status, loop.inbox]);
  useEffect(() => () => publishWaiting(null), []);

  // The browser tab says the same thing as the sentence, so the answer is there even when the page is not in front.
  const titleWas = useRef<string | null>(null);
  useEffect(() => {
    if (loop.status !== "ready") return;
    titleWas.current ??= document.title;
    const { you, stopped, self } = board.fleet.groups;
    const say = you ? `${you} ${you === 1 ? "needs" : "need"} you` : stopped ? `${stopped} stopped` : self ? `${self} moving` : "Quiet";
    document.title = `${say} · Ephyra`;
  }, [loop.status, board]);
  useEffect(() => () => { if (titleWas.current !== null) document.title = titleWas.current; }, []);

  // With sound switched on: one cue when a quest starts to need you, a softer one when a quest finishes.
  // Nothing sounds for what was already so when the page opened.
  const heard = useRef<{ needs: Set<string>; done: Set<string> } | null>(null);
  useEffect(() => {
    if (loop.status !== "ready") return;
    const ids = (attention: QuestView["attention"]) => new Set(board.views.filter((view) => view.attention === attention).map((view) => view.id));
    const was = heard.current;
    const now = { needs: ids("needs_you"), done: ids("set") };
    heard.current = now;
    if (!was) return;
    if ([...now.needs].some((id) => !was.needs.has(id))) playFeedback("attention");
    else if ([...now.done].some((id) => !was.done.has(id))) playFeedback("message");
  }, [loop.status, board]);

  // A quest being watched after its landing counts its window down, second by second.
  const watching = selected?.trail.state === "watching";
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (!watching) return;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [watching, selected?.id]);
  const watch = selected && watching ? watchProgress(selected.trail, selected.events, new Date(clockNow).toISOString()) : null;

  // An announcement stays up while its write is still in flight, then leaves by itself.
  useEffect(() => {
    if (!toast || busy) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast, busy]);

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

  /**
   * One write at a time, each under its own operation key. It answers whether the write went through, so a form can
   * keep what was typed when it did not. The board is read again whatever the outcome.
   */
  const refresh = loop.refresh;
  const write = useCallback(async <T,>(
    about: QuestView, what: string, doing: string, done: string | ((result: T) => string), work: (op: string) => Promise<T>,
  ): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setProblem(null);
    // Say so at once. The server may take a moment (an approval lands the change before it answers).
    setToast(doing);
    try {
      const result = await work(crypto.randomUUID());
      setToast(typeof done === "string" ? done : done(result));
      return true;
    } catch (error) {
      setToast("");
      fail(explain(what, error), about);
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
      refresh();
    }
  }, [refresh, fail]);

  // A failure stays until it is dismissed while the quest is as it was. Once that quest has moved on, the note has
  // said what it had to say and leaves by itself a little later.
  useEffect(() => {
    if (!problem?.quest) return;
    const now = board.quests.find((quest) => quest.id === problem.quest)?.view;
    if (now && `${now.state}:${now.attention}` === problem.was) return;
    const timer = setTimeout(() => setProblem(null), Math.max(0, problem.at + 15_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [problem, board]);

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
  const closed = useCallback((about: QuestView) => {
    fail("That request is no longer open. The board has been read again.", about);
    refresh();
    return Promise.resolve(false);
  }, [refresh, fail]);

  const act = useCallback((quest: QuestView) => {
    const action = quest.action;
    if (!action) return;
    if (!canAct) { fail("You can follow this workspace but not change it."); return; }
    if (action.kind === "answer") {
      setPicked(quest.id);
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-answer] textarea")?.focus());
      return;
    }
    if (action.kind === "resume" || action.kind === "release") {
      const done = action.kind === "resume" ? `Resumed ${quest.short}.` : `Released ${quest.short}. It carries on by itself.`;
      void write(quest, action.kind, action.kind === "resume" ? `Resuming ${quest.short}.` : `Releasing ${quest.short}.`, done,
        (op) => api.trailAction(quest.id, action.kind, {}, op));
      return;
    }
    const gate = gateOf(quest);
    if (!gate) { void closed(quest); return; }
    playFeedback("connected");
    void write(quest, "approve", `Approving ${quest.short}.`,
      action.kind === "spend" ? `Approved the spend. ${quest.short} carries on.` : `Approved. ${quest.short} moves on by itself.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "approve" }, op));
  }, [api, canAct, gateOf, write, closed, fail]);

  const revise = useCallback((quest: QuestView, note: string) => {
    const gate = gateOf(quest);
    if (!canAct || !gate) return closed(quest);
    return write(quest, "send it back", `Sending ${quest.short} back.`,
      `Sent ${quest.short} back with your note. It becomes the next attempt's first observation.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "revise", note }, op));
  }, [api, canAct, gateOf, write, closed]);

  // Dropping ends a quest. The strip asks for a second, explicit press before this is called.
  const drop = useCallback((quest: QuestView) => {
    const gate = gateOf(quest);
    if (!canAct || !gate) return closed(quest);
    return write(quest, "drop it", `Dropping ${quest.short}.`, `Dropped ${quest.short}. Nothing lands.`,
      (op) => api.decide(quest.id, { ...gate, verdict: "reject" }, op));
  }, [api, canAct, gateOf, write, closed]);

  const answer = useCallback((quest: QuestView, text: string) => {
    if (quest.action?.kind !== "answer") return Promise.resolve(false);
    const question = quest.action.questionId;
    return write<InvestigationQuestion>(quest, "send your answer", `Sending your answer. It is checked before ${quest.short} carries on.`,
      (saved) => saved.status === "answered" ? `Answer accepted as evidence. ${quest.short} carries on by itself.`
        : `The check did not accept that answer as evidence, so ${quest.short} stays stopped.`,
      (op) => api.answerQuestion(quest.id, question, { text }, op));
  }, [api, write]);

  // Whatever had focus when the hood opened gets it back when the hood closes.
  const openHood = useCallback(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setHood(true);
  }, []);
  const hoodWas = useRef(hood);
  useEffect(() => {
    if (hoodWas.current && !hood) {
      const back = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>("[data-open-hood]");
      back?.focus();
    }
    hoodWas.current = hood;
  }, [hood]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      // A modal owns the keyboard: the hood below the wide breakpoint, the command menu, any dialog.
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
        case "a": {
          if (!needs) return;
          setPicked(needs.id);
          // Focus moves in the same keystroke, so `a` then `Enter` works however fast they are typed.
          const primary = document.querySelector<HTMLElement>("[data-primary]");
          if (primary) primary.focus();
          else requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-primary]")?.focus());
          break;
        }
        case "i":
          if (!selected) return;
          if (hood) setHood(false); else openHood();
          break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, needs, hood, select, openHood]);

  if (loop.status === "loading") return <Skeleton block />;
  if (loop.status === "error") return <ErrorState error={loop.error} onRetry={loop.refresh} />;

  const view = selected?.view ?? null;
  const lost = loop.error !== null && loop.heardAt !== null;
  // An address can name a quest this server does not have. Say so, instead of quietly showing a different one.
  const unknown = picked !== null && !board.quests.some((quest) => quest.view.short === picked || quest.id === picked)
    ? picked.slice(0, 40) : null;
  const hoodNotes = [
    selected?.effects === null ? "This server keeps no record of effects for this quest, so that tab is empty." : null,
    loop.unavailable.includes("runs") || loop.unavailable.includes("transcripts")
      ? "Agent runs could not be read just now. What is listed may be out of date." : null,
  ].filter(Boolean).join(" ");
  const scene = (
    <LoopScene views={sceneViews(board.views)} selected={selected?.id} current={view?.stage.id} narrow={narrow} compact onSelect={select} />
  );
  const unwatched = connected === false && board.quests.length === 0;
  const bench = unwatched
    ? <p className="lp-board-note">No repository is connected, so nothing is watched. <a href="#/onboarding">Connect one</a> and
      Ephyra opens a quest by itself when its production reports a problem.</p>
    : board.quests.length === 0
    ? <p className="lp-board-note">No quests yet. Ephyra opens one by itself when a signal arrives from production.</p>
    : <QuestGroups views={board.views} selected={selected?.id} narrow={narrow} finished={5} onSelect={select} />;
  return (
    <div className="lp-page" data-loop-page data-busy={busy || undefined} data-hood={hood ? (roomy ? "column" : "modal") : undefined}>
      <div className="lp-board" data-layout="h">
        <div className="lp-board-main">
          <FleetSentence fleet={unwatched ? { ...board.fleet, sentence: "Nothing is watched yet. No repository is connected." }
            : board.fleet} />
          {/* Always present, so a change in how fresh the board is gets announced rather than only drawn. */}
          <div className="lp-board-notes" aria-live="polite">
            {lost && (
              <p className="lp-board-note" data-tone="warn" data-stale>
                Lost contact with the server. This is what it last reported, at {clock(loop.heardAt!)}. Trying again.
              </p>
            )}
            {!lost && loop.unavailable.length > 0 && (
              <p className="lp-board-note" data-tone="warn" data-partial>
                Could not refresh {list(loop.unavailable)} just now. Showing what was last read.{" "}
                <button type="button" className="lp-quiet" onClick={loop.refresh}>Try again</button>
              </p>
            )}
          </div>
          {unknown && (
            <p className="lp-board-note" data-tone="warn" data-unknown-quest>
              There is no quest called “{unknown}” here.{view ? ` Showing ${view.short} instead.` : ""}
            </p>
          )}
          {problem && (
            <p className="lp-board-note" data-tone="bad" data-problem role="alert">
              {problem.text}{" "}
              <button type="button" className="lp-quiet" onClick={() => setProblem(null)}>Dismiss</button>
            </p>
          )}
          {needs && (
            <NeedsYou quest={needs.view} proof={proofLine(needs.events)} more={Math.max(0, waiting.length - 1)} busy={busy} onAct={act}
              onRevise={canAct ? revise : undefined} onDrop={canAct ? drop : undefined} />
          )}
          {/* On a phone the names come first: the scene has no room for them there, so it follows the list. */}
          {narrow ? <>{bench}{scene}</> : <>{scene}{bench}</>}
          <p className="lp-foot">
            {/* The dot beats each time the server answers, so "live" is something you can see, not a claim. */}
            <span className="lp-live" data-live={lost ? "lost" : "ok"}>
              <i key={loop.heardAt ?? 0} aria-hidden="true" />
              {lost ? "Out of touch with the server" : `Live. Checking every ${pollDelay(board.views) / 1000} s`}
            </span>
            {!narrow && board.quests.length > 0 && (
              <span className="lp-keys" data-keys>
                <span><kbd>j</kbd><kbd>k</kbd>walk the quests</span>
                {needs?.view.action && <span><kbd>a</kbd>then<kbd>Enter</kbd>to {needs.view.action.label.toLowerCase()}</span>}
                <span><kbd>i</kbd>under the hood</span>
              </span>
            )}
          </p>
        </div>
        <aside className="lp-board-aside" aria-label="Selected quest" ref={aside}>
          {selected && view ? (
            <Referable id={`trail:${selected.id}`} refData={{ kind: "trail", id: selected.id, rev: selected.trail.rev }}
              label={`${view.short}: ${view.title}`} href={`#/loop/${encodeURIComponent(view.short)}`}>
            <QuestDetail quest={view} steps={steps} now={now} run={running} onInspect={openHood}
              pending={selected.loaded ? null : "Reading this quest's journal."}>
              {watch && (
                <div className="lp-watch" data-watch>
                  <span>Watch window</span>
                  <span>{watch.ratio >= 1 ? "Passed. Closing." : `${left(watch.windowS - watch.elapsedS)} left of ${left(watch.windowS)}`}</span>
                  <i aria-hidden="true" style={{ "--ratio": watch.ratio.toFixed(3) } as CSSProperties} />
                </div>
              )}
              {selected.loaded && loop.stale(selected.id) && (
                <p className="lp-board-note" data-tone="warn" data-stale-quest>
                  Could not refresh this quest's evidence just now. Showing what was last read.
                </p>
              )}
              {view.action?.kind === "answer" && canAct && <AnswerForm key={view.action.questionId} quest={view} busy={busy} onAnswer={answer} />}
              {view.attention !== "needs_you" && (view.action?.kind === "resume" || view.action?.kind === "release") && canAct && (
                <p className="lp-detail-act">
                  <button type="button" className="lp-quiet" data-quiet-action={view.action.kind} disabled={busy} onClick={() => act(view)}>
                    {view.action.label}
                  </button>
                </p>
              )}
            </QuestDetail>
            </Referable>
          ) : <p className="lp-board-empty">Nothing to look at yet.</p>}
        </aside>
      </div>

      {hood && selected && (
        <Inspector key={roomy ? "column" : "modal"} mode={roomy ? "column" : "modal"} tab={tab} onTab={setTab} onClose={() => setHood(false)}
          note={hoodNotes || undefined}
          hood={{ view: selected.view, events: selected.events, effects: selected.effects ?? [], runs: loop.runs, runEvents: loop.runEvents }} />
      )}

      <div className="lp-toast" role="status" aria-live="polite" data-toast>{toast}</div>
    </div>
  );
}

/**
 * The answer to a question that was addressed to this person. The server checks it before the quest resumes. What was
 * typed stays in the box until the server has taken it.
 */
function AnswerForm({ quest, busy, onAnswer }: { quest: QuestView; busy: boolean; onAnswer: (quest: QuestView, text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && !busy) void onAnswer(quest, text.trim());
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
