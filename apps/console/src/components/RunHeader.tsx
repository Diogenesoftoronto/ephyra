import type { AgentRun } from "@ephyra/core";
import { Badge, Card, Tag } from "../kit.ts";
import { formatMicrousd, formatTokens, safeHref } from "../lib/format.ts";
import { Elapsed } from "./Elapsed.tsx";
import { ExecutorChip } from "./ExecutorChip.tsx";
import { PersonaLabel } from "./PersonaLabel.tsx";
import { RUN_TONE } from "./RunList.tsx";
import "./RunHeader.css";

export type StreamState = "idle" | "live" | "reconnecting" | "ended";

/** Who ran what, where, and the links out: the engine's own thread, and a live preview when the engine opened one. */
export function RunHeader({ run, stream = "idle" }: { run: AgentRun; stream?: StreamState }) {
  const thread = safeHref(run.executor.threadUrl);
  const portal = safeHref(run.executor.portalUrl);
  return (
    <Card tone={run.status === "running" ? "live" : run.status === "failed" ? "alert" : "plain"}>
      <div className="run-header">
        <div className="run-header-who">
          <PersonaLabel persona={run.persona} size={32} />
          <strong>{run.step}</strong>
          {run.short && run.trailId && <a className="mono" href={`#/inbox/${run.trailId}`}>{run.short}</a>}
          <Tag>{run.engine}</Tag>
        </div>
        <div className="run-header-status">
          <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
          {run.status === "running" && <Badge tone={stream === "reconnecting" ? "warn" : "live"}>{stream === "reconnecting" ? "reconnecting…" : "following live"}</Badge>}
          <span className="muted num">{run.endedAt ? <Elapsed since={run.startedAt} until={run.endedAt} /> : <Elapsed since={run.startedAt} />}</span>
        </div>
        <div className="run-header-where"><ExecutorChip executor={run.executor} /></div>
        <div className="run-header-links">
          {thread && <a href={thread} target="_blank" rel="noopener noreferrer">Open in Amp ↗</a>}
          {portal && <a href={portal} target="_blank" rel="noopener noreferrer">Live preview ↗</a>}
          {!thread && !portal && <span className="muted">No external links for this run.</span>}
        </div>
        {run.usage && (
          <p className="muted run-header-usage">{formatTokens(run.usage.tokens)} tokens · {run.usage.costMicrousd === null ? "cost unknown" : formatMicrousd(run.usage.costMicrousd)}</p>
        )}
        {run.error && <p role="alert" className="run-header-error"><strong>{run.status === "unavailable" ? "Unavailable." : "Failed."}</strong> {run.error}</p>}
      </div>
    </Card>
  );
}
