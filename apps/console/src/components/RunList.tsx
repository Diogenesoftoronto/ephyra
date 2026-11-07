import type { AgentRun } from "@ephyra/core";
import { Badge, Empty, Tag } from "../kit.ts";
import { Elapsed } from "./Elapsed.tsx";
import { ExecutorChip } from "./ExecutorChip.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import "./RunList.css";

export const RUN_TONE = { running: "live", done: "ok", failed: "bad", unavailable: "warn" } as const;

export function RunRow({ run }: { run: AgentRun }) {
  return (
    <li>
      <a className="run-row" href={`#/runs/${run.id}`}>
        {run.persona ? <PersonaAvatar persona={run.persona} size={32} live={run.status === "running"} /> : <span className="run-noface" aria-hidden />}
        <span className="run-main">
          <span className="run-top">
            <strong>{run.step}</strong>
            {run.short && <span className="mono muted">{run.short}</span>}
            <Tag>{run.engine}</Tag>
          </span>
          <span className="run-where"><ExecutorChip executor={run.executor} />
            {run.executor.portalUrl && <Badge tone="info">preview</Badge>}
          </span>
          {run.error && <span className="run-error muted">{run.error}</span>}
        </span>
        <span className="run-side">
          <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
          <span className="muted num">{run.status === "running" ? <Elapsed since={run.startedAt} /> : run.endedAt ? <Elapsed since={run.startedAt} until={run.endedAt} /> : null}</span>
        </span>
      </a>
    </li>
  );
}

export function RunList({ runs, empty = "No runs match." }: { runs: AgentRun[]; empty?: string }) {
  if (runs.length === 0) return <Empty title={empty} body="Agent steps appear here as they start." />;
  return <ul className="run-list" aria-label="Agent runs">{runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>;
}
