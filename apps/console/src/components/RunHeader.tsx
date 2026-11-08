import type { AgentRun } from "@ephyra/core";
import { Card, Status } from "../kit.ts";
import { formatMicrousd, formatTokens } from "../lib/format.ts";
import { Elapsed } from "./Elapsed.tsx";
import { EngineBadge } from "./EngineBadge.tsx";
import { PersonaLabel } from "./PersonaLabel.tsx";
import { RunStatus } from "./RunList.tsx";
import { RunAccess } from "./RunAccess.tsx";
import "./RunHeader.css";

export type StreamState = "idle" | "live" | "reconnecting" | "ended";

/** Who ran what, where, and the links out: the engine's own thread, and a live preview when the engine opened one. */
export function RunHeader({ run, stream = "idle" }: { run: AgentRun; stream?: StreamState }) {
  return (
    <Card tone={run.status === "failed" ? "alert" : "quiet"}>
      <div className="run-header">
        <div className="run-header-line">
          <PersonaLabel persona={run.persona} size={32} />
          <strong>{run.step}</strong>
          {run.short && run.trailId && (
            <a className="mono" href={`#/inbox/${run.trailId}`}>
              {run.short}
            </a>
          )}
          <EngineBadge engine={run.engine} executor={run.executor} />
        </div>
        <div className="run-header-line">
          <RunStatus status={run.status} />
          {run.status === "running" &&
            (stream === "reconnecting" ? (
              <Status state="stale" />
            ) : (
              <span className="muted">following live</span>
            ))}
          <span className="muted num">
            {run.endedAt ? (
              <Elapsed since={run.startedAt} until={run.endedAt} />
            ) : (
              <Elapsed since={run.startedAt} />
            )}
          </span>
        </div>
        <RunAccess run={run} />
        {run.usage && (
          <p className="muted run-header-text">
            {formatTokens(run.usage.tokens)} tokens ·{" "}
            {run.usage.costMicrousd === null ? "cost unknown" : formatMicrousd(run.usage.costMicrousd)}
          </p>
        )}
        {run.error && (
          <p role="alert" className="run-header-text">
            <strong>{run.status === "unavailable" ? "Unavailable." : "Failed."}</strong> {run.error}
          </p>
        )}
      </div>
    </Card>
  );
}
