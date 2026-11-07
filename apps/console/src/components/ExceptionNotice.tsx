import type { AgentRun } from "@ephyra/core";
import { Button, Notice } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";

/**
 * The one exception worth interrupting for: the most recent failed or unavailable agent run in the last day. Nothing is
 * shown when every recent run went well.
 */
export function ExceptionNotice({ runs }: { runs: AgentRun[] }) {
  const now = useNow(60_000);
  const bad = runs
    .filter(
      (r) =>
        (r.status === "failed" || r.status === "unavailable") && now - Date.parse(r.startedAt) < 86_400_000,
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const first = bad[0];
  if (!first) return null;
  const more = bad.length - 1;
  return (
    <Notice
      tone={first.status === "failed" ? "bad" : "warn"}
      title={`${first.step} ${first.status === "failed" ? "failed" : "could not run"}${first.short ? ` on ${first.short}` : ""}`}
      body={
        <>
          {first.error ?? "No reason was recorded."}{" "}
          <span className="muted">
            {relativeTime(first.endedAt ?? first.startedAt, now)}
            {more > 0 ? ` · and ${more} more` : ""}
          </span>
        </>
      }
      actions={
        <a className="ui-button ui-button--sm ui-button--secondary" href={`#/runs/${first.id}`}>
          Open run
        </a>
      }
    />
  );
}
