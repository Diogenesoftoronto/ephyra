import type { AgentRun } from "@ephyra/core";
import { Empty, Row, Rows, Status } from "../kit.ts";
import { Elapsed } from "./Elapsed.tsx";
import { EngineBadge } from "./EngineBadge.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import { RunAccess } from "./RunAccess.tsx";
import "./RunList.css";
import { Referable } from "../velum/VelumProvider.tsx";

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
      className="run-row"
      lead={
        run.persona ? (
          <PersonaAvatar persona={run.persona} size={32} live={run.status === "running"} />
        ) : undefined
      }
      title={
        <a className="run-row__link" href={`#/runs/${run.id}`}>
          {run.step}
          {run.short ? (
            <>
              {" "}
              on <span className="mono">{run.short}</span>
            </>
          ) : null}
        </a>
      }
      meta={
        <span className="run-row__meta">
          <EngineBadge engine={run.engine} executor={run.executor} />
          <RunAccess run={run} compact />
          {run.error && <span>{run.error}</span>}
        </span>
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
        <Referable key={r.id} id={`run:${r.id}`} refData={{ kind: "run", id: r.id }}
          label={`${r.step}${r.short ? ` on ${r.short}` : ""}`} href={`#/runs/${r.id}`}>
          <RunRow run={r} />
        </Referable>
      ))}
    </Rows>
  );
}
