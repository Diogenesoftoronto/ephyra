import { elapsedMs, formatDuration } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";

/** Time since `since`, ticking while mounted. Use `until` for a finished span. */
export function Elapsed({ since, until }: { since: string; until?: string }) {
  const now = useNow();
  const ms = until ? Date.parse(until) - Date.parse(since) : elapsedMs(since, now);
  return <time className="num" dateTime={since} title={`Since ${since}`}>{formatDuration(ms)}</time>;
}
