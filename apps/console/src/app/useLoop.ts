// Keeps the loop board in step with the server by polling. Every piece of state the board shows comes from here, so a
// reload is never needed. A stream would be cheaper; until the server has one for quests, this asks every two seconds.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun, AgentRunEvent, InvestigationQuestion, Trail } from "@ephyra/core";
import { ApiError, type ConsoleApi, type InboxEntry, type TrailDetail } from "../api.ts";
import { assemble, detailPlan, mergeRunEvents, type LiveBoard } from "../loop/live.ts";
import { lastOf } from "../loop/model.ts";

const POLL_MS = 2000;

type Snapshot = {
  trails: Trail[];
  inbox: InboxEntry[];
  questions: InvestigationQuestion[];
  details: Map<string, TrailDetail>;
  /** Runs of the selected quest, oldest first. */
  runs: AgentRun[];
  runEvents: Map<string, AgentRunEvent[]>;
  /** Quests whose journal could not be read on the last try. What is shown for them is from an earlier read. */
  stale: Set<string>;
  /** Parts of the board the last poll could not refresh: "questions", "runs", "transcripts". */
  unavailable: string[];
  /** When the server last answered. */
  at: number;
};

export type LoopState = {
  status: "loading" | "ready" | "error";
  board: LiveBoard;
  inbox: readonly InboxEntry[];
  runs: readonly AgentRun[];
  runEvents: (runId: string) => readonly AgentRunEvent[];
  /** Set when the last poll failed. The board keeps showing what it last heard. */
  error: unknown | null;
  heardAt: number | null;
  /** False when this server does not serve investigation questions. */
  questionsServed: boolean;
  /** Parts of the board that could not be refreshed just now. The last good copy stays on screen. */
  unavailable: readonly string[];
  /** True when this quest's journal could not be read on the last try. */
  stale: (questId: string) => boolean;
  refresh: () => void;
};

const EMPTY: Snapshot = {
  trails: [], inbox: [], questions: [], details: new Map(), runs: [], runEvents: new Map(), stale: new Set(), unavailable: [], at: 0,
};
const notServed = (error: unknown) => error instanceof ApiError && [403, 404, 501].includes(error.status);

export function useLoop(api: ConsoleApi, opts: { viewer?: string; selected: string | null; transcripts: boolean }): LoopState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [questionsServed, setQuestionsServed] = useState(true);
  const latest = useRef<Snapshot>(EMPTY);
  const want = useRef(opts);
  want.current = opts;
  const busy = useRef(false);
  const again = useRef(false);
  const cursor = useRef(0);
  const asking = useRef(true);
  const live = useRef(true);

  const poll = useCallback(async () => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try {
      const had = latest.current;
      const unavailable = new Set<string>();
      const [trails, inbox, questions] = await Promise.all([
        api.trails(), api.inbox(),
        asking.current ? api.questions().catch((problem: unknown) => {
          // A server with no question routes is a normal deployment. Anything else keeps the last answer.
          if (notServed(problem)) { asking.current = false; return [] as InvestigationQuestion[]; }
          unavailable.add("questions");
          return had.questions;
        }) : Promise.resolve([] as InvestigationQuestion[]),
      ]);
      const { selected, transcripts } = want.current;
      const known = new Map([...had.details].map(([id, detail]) => [id, detail.trail.updatedAt]));
      const plan = detailPlan({ trails, known, selected, cursor: cursor.current });
      cursor.current = plan.cursor;
      const read = await Promise.all(plan.ids.map((id) => api.trail(id).then((detail) => [id, detail] as const, () => [id, null] as const)));
      const details = new Map([...had.details].filter(([id]) => trails.some((trail) => trail.id === id)));
      const stale = new Set([...had.stale].filter((id) => trails.some((trail) => trail.id === id)));
      for (const [id, detail] of read) {
        if (detail) { details.set(id, detail); stale.delete(id); } else stale.add(id);
      }

      let runs = selected === null ? [] : had.runs.filter((run) => run.trailId === selected);
      const runEvents = new Map(had.runEvents);
      if (selected !== null) {
        const listed = await api.runs({ trail: selected, limit: 30 }).catch(() => null);
        if (listed) runs = [...listed].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        else unavailable.add("runs");
        const running = lastOf(runs, (run) => run.status === "running");
        // The running agent's transcript feeds the "now" line. Finished runs are read only when someone opens the hood.
        const wanted = transcripts ? runs : running ? [running] : [];
        await Promise.all(wanted.map(async (run) => {
          const have = runEvents.get(run.id) ?? [];
          if (run.status !== "running" && have.length && runEvents.get(`${run.id}:done`)) return;
          const more = await api.runEvents(run.id, have.at(-1)?.seq).catch(() => null);
          if (!more) { unavailable.add("transcripts"); return; }
          runEvents.set(run.id, mergeRunEvents(have, more));
          if (run.status !== "running") runEvents.set(`${run.id}:done`, []);
        }));
      }
      const next: Snapshot = { trails, inbox, questions, details, runs, runEvents, stale, unavailable: [...unavailable], at: Date.now() };
      latest.current = next;
      if (!live.current) return;
      setSnapshot(next);
      setQuestionsServed(asking.current);
      setError(null);
    } catch (problem) {
      if (live.current) setError(problem);
    } finally {
      busy.current = false;
      if (again.current && live.current) { again.current = false; void poll(); }
    }
  }, [api]);

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (typeof document === "undefined" || !document.hidden) void poll();
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  // A newly selected quest, or an opened hood, should not wait for the next tick.
  useEffect(() => { void poll(); }, [poll, opts.selected, opts.transcripts]);

  const board = useMemo(() => assemble({
    trails: snapshot?.trails ?? [], details: snapshot?.details ?? EMPTY.details, inbox: snapshot?.inbox ?? [],
    questions: snapshot?.questions ?? [], runs: snapshot?.runs ?? [], viewer: opts.viewer,
  }), [snapshot, opts.viewer]);
  const runEvents = useCallback((runId: string) => snapshot?.runEvents.get(runId) ?? [], [snapshot]);
  const stale = useCallback((questId: string) => snapshot?.stale.has(questId) ?? false, [snapshot]);
  const refresh = useCallback(() => { void poll(); }, [poll]);

  return {
    status: snapshot ? "ready" : error ? "error" : "loading",
    board, inbox: snapshot?.inbox ?? [], runs: snapshot?.runs ?? [], runEvents,
    error, heardAt: snapshot?.at ?? null, questionsServed, unavailable: snapshot?.unavailable ?? [], stale, refresh,
  };
}
