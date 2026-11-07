import { useEffect, useRef, useState } from "react";
import type { AgentRun, AgentRunEvent } from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import type { StreamState } from "../components/RunHeader.tsx";

export type RunStream =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; run: AgentRun; events: AgentRunEvent[]; stream: StreamState };

const MAX_RETRIES = 5;

/**
 * Load a run and its events, then follow it live while it is running. Events are de-duplicated by `seq`; after a dropped
 * stream the client resumes from the last `seq` it saw. When the stream ends, the run is read again for its final status.
 */
export function useRunStream(api: ConsoleApi, runId: string, retryMs = 2000): RunStream {
  const [state, setState] = useState<RunStream>({ status: "loading" });
  const seen = useRef(new Map<number, AgentRunEvent>());

  useEffect(() => {
    const ctl = new AbortController();
    seen.current = new Map();
    setState({ status: "loading" });
    const merge = (batch: AgentRunEvent[]) => { for (const e of batch) seen.current.set(e.seq, e); };
    const ordered = () => [...seen.current.values()].sort((a, b) => a.seq - b.seq);
    const lastSeq = () => (seen.current.size ? Math.max(...seen.current.keys()) : undefined);

    (async () => {
      try {
        const [run, first] = await Promise.all([api.run(runId), api.runEvents(runId)]);
        merge(first);
        if (ctl.signal.aborted) return;
        setState({ status: "ready", run, events: ordered(), stream: run.status === "running" ? "live" : "ended" });
        if (run.status !== "running") return;
        let retries = 0;
        while (!ctl.signal.aborted) {
          try {
            await api.watchRun(runId, lastSeq(), (batch) => {
              merge(batch);
              retries = 0;
              setState((s) => (s.status === "ready" ? { ...s, events: ordered(), stream: "live" } : s));
            }, ctl.signal);
            if (ctl.signal.aborted) return;
            const final = await api.run(runId);
            setState((s) => (s.status === "ready" ? { ...s, run: final, stream: "ended" } : s));
            return;
          } catch (error) {
            if (ctl.signal.aborted) return;
            if (++retries > MAX_RETRIES) { setState({ status: "error", error }); return; }
            setState((s) => (s.status === "ready" ? { ...s, stream: "reconnecting" } : s));
            await new Promise((r) => setTimeout(r, retryMs));
          }
        }
      } catch (error) {
        if (!ctl.signal.aborted) setState({ status: "error", error });
      }
    })();
    return () => ctl.abort();
  }, [api, runId, retryMs]);

  return state;
}
