import type { AgentRun } from "@ephyra/core";
import { Empty, Row, Rows, Status, Tag } from "../kit.ts";
import { Elapsed } from "./Elapsed.tsx";
import { ExecutorChip } from "./ExecutorChip.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";

export const RUN_STATE = {
  running: "running",
  done: "done",
  failed: "failed",
  unavailable: "stale",
} as const;

/** The run's status. "Unavailable" reuses the stale state: the engine did not answer. */
export function RunStatus({ status }: { status: AgentRun["status"] }) {
  return <Status state={RUN_STATE[status]}>{status === "unavailable" ? "Unavailable" : undefined}</Status>;
}

export function RunRow({ run }: { run: AgentRun }) {
  return (
    <Row
      href={`#/runs/${run.id}`}
      lead={
        run.persona ? (
          <PersonaAvatar persona={run.persona} size={32} live={run.status === "running"} />
        ) : undefined
      }
      title={
        <>
          {run.step}
          {run.short ? (
            <>
              {" "}
              on <span className="mono">{run.short}</span>
            </>
          ) : null}
        </>
      }
      meta={
        <>
          <Tag>{run.engine}</Tag> · <ExecutorChip executor={run.executor} />
          {run.executor.portalUrl ? " · preview" : ""}
          {run.error ? <> · {run.error}</> : null}
        </>
      }
      aside={
        <>
          <RunStatus status={run.status} />
          <span className="num muted">
            {run.endedAt ? (
              <Elapsed since={run.startedAt} until={run.endedAt} />
            ) : (
              <Elapsed since={run.startedAt} />
            )}
          </span>
        </>
      }
    />
  );
}

export function RunList({ runs, empty = "No runs match." }: { runs: AgentRun[]; empty?: string }) {
  if (runs.length === 0) return <Empty title={empty} body="Agent steps appear here as they start." />;
  return (
    <Rows>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} />
      ))}
    </Rows>
  );
}
