import type { AgentRun, AgentRunEvent } from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import type { StreamState } from "../components/RunHeader.tsx";

export type RunSnapshot = { run: AgentRun; events: AgentRunEvent[]; stream: StreamState; error?: unknown };
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

/** A closed connection is not completion. Only a final run record can finish the transcript. */
export async function followRun(
  api: ConsoleApi,
  id: string,
  signal: AbortSignal,
  publish: (snapshot: RunSnapshot) => void,
  retryMs = 2000,
) {
  const seen = new Map<number, AgentRunEvent>();
  const merge = (batch: AgentRunEvent[]) => {
    for (const event of batch) if (event.runId === id) seen.set(event.seq, event);
  };
  const [initial, events] = await Promise.all([api.run(id), api.runEvents(id)]);
  if (signal.aborted) return;
  let run = initial;
  merge(events);
  const show = (stream: StreamState, error?: unknown) => {
    if (!signal.aborted)
      publish({ run, events: [...seen.values()].sort((a, b) => a.seq - b.seq), stream, error });
  };
  show(run.status === "running" ? "live" : "ended");
  if (run.status !== "running") return;
  let retries = 0;
  while (!signal.aborted) {
    try {
      const after = seen.size ? Math.max(...seen.keys()) : undefined;
      await api.watchRun(
        id,
        after,
        (batch) => {
          if (signal.aborted) return;
          const before = seen.size;
          merge(batch);
          if (seen.size > before) retries = 0;
          show(run.status === "running" ? "live" : "ended");
        },
        signal,
        (snapshot) => {
          if (signal.aborted || snapshot.id !== id) return;
          run = snapshot;
          show(run.status === "running" ? "live" : "ended");
        },
      );
      if (signal.aborted) return;
      run = await api.run(id);
      if (signal.aborted) return;
      if (run.status !== "running") {
        show("ended");
        return;
      }
      throw new Error("The connection closed while this run was still active.");
    } catch (error) {
      if (signal.aborted) return;
      show("reconnecting", error);
      if (++retries > 5) return; // Keep the last transcript available for review.
      await delay(retryMs, signal);
    }
  }
}
