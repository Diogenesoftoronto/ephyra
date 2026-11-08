import { useApi } from "../app/ApiContext.tsx";
import { useRunStream } from "../app/useRunStream.ts";
import { RunThread } from "../assistant/RunThread.tsx";
import { Card, Notice, PageHeader, Skeleton } from "../kit.ts";
import { ErrorState } from "../components/Load.tsx";
import { RunHeader } from "../components/RunHeader.tsx";
import { RunVisuals } from "../components/RunVisuals.tsx";
import "./RunPage.css";

/** One agent run as a read-only transcript. A running run is followed live; a finished one is replayed. */
export function RunPage({ runId, retryMs }: { runId: string; retryMs?: number }) {
  const api = useApi();
  const s = useRunStream(api, runId, retryMs);
  return (
    <div className="page">
      <p className="run-back">
        <a href="#/runs">← All runs</a>
      </p>
      <PageHeader title="Run" lede="Follow the work, inspect what the agent shares, or open its session." />
      {s.status === "loading" && <Skeleton block />}
      {s.status === "error" && <ErrorState error={s.error} />}
      {s.status === "ready" && (
        <>
          <RunHeader run={s.run} stream={s.stream} />
          {s.error && (
            <Notice
              tone="warn"
              title="Updates delayed"
              body="The last received transcript is below. Reload this page to reconnect."
            />
          )}
          <div className="run-workspace">
            <RunVisuals key={s.run.id} run={s.run} events={s.events} />
            <Card tone="tray" title="Transcript" meta="Read only">
              <RunThread run={s.run} events={s.events} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
