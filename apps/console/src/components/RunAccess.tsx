import type { AgentRun } from "@ephyra/core";
import { runLink, runThreadLabel } from "../lib/run-presentations.ts";
import "./RunAccess.css";

/** Recorded external access only. An Ephyra role does not confer access on Amp. */
export function RunAccess({ run, compact = false }: { run: AgentRun; compact?: boolean }) {
  const thread = runLink(run.executor.threadUrl);
  const portal = runLink(run.executor.portalUrl);
  if (compact && !thread && !portal) return null;
  return <span className={`run-access${compact ? " run-access--compact" : ""}`}>
    {thread && <a className={compact ? undefined : "ui-button ui-button--secondary ui-button--sm"}
      href={thread} target="_blank" rel="noopener noreferrer">{runThreadLabel(run)} ↗</a>}
    {portal && <a className={compact ? undefined : "ui-button ui-button--ghost ui-button--sm"}
      href={portal} target="_blank" rel="noopener noreferrer">Open app preview ↗</a>}
    {!compact && <span className="run-access__hint">{thread && run.executor.kind === "orb"
      ? "Follow the conversation, terminal and files in Amp. Your Amp account controls access."
      : !thread ? "The agent has not reported a session link yet." : "Opens the agent’s own session."}</span>}
  </span>;
}
