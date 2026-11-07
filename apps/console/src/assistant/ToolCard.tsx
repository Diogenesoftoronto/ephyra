import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { Badge, Card } from "../kit.ts";
import type { PolicyNote, ToolArtifact } from "./messages.ts";

const DECISION = { allow: "ok", reject: "bad", modify: "warn" } as const;

/** A harness plugin's decision on a tool call: allow, reject or modify, with the rule and the reason. */
export function PolicyBadge({ policy }: { policy: PolicyNote }) {
  return (
    <span className="tool-policy" data-decision={policy.decision}>
      <Badge tone={DECISION[policy.decision]}>policy: {policy.decision}</Badge>
      <span className="mono">{policy.rule}</span>
      <span className="muted">{policy.reason}</span>
    </span>
  );
}

const pretty = (text: string | undefined): string => {
  if (!text) return "";
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

/**
 * A tool call as a collapsible card: tool name, arguments, result or error, and any plugin decisions. A rejected or
 * failed call opens by default so the reason is not hidden.
 */
export function ToolCard(part: ToolCallMessagePartProps) {
  const artifact = (part.artifact ?? { policy: [] }) as Partial<ToolArtifact>;
  const policy = artifact.policy ?? [];
  const rejected = policy.some((p) => p.decision === "reject");
  const failed = part.isError === true;
  const pending = part.result === undefined;
  return (
    <Card tone={rejected || failed ? "alert" : "inset"} className="tool-card-wrap">
      <details className="tool-card" open={rejected || failed || undefined}>
        <summary>
          <strong className="mono">{part.toolName}</strong>
          {pending ? <Badge tone="live">running</Badge> : failed ? <Badge tone="bad">error</Badge> : <Badge tone="ok">done</Badge>}
          {policy.map((p, i) => <Badge key={i} tone={DECISION[p.decision]}>{p.decision}</Badge>)}
        </summary>
        {policy.map((p, i) => <PolicyBadge key={i} policy={p} />)}
        {part.argsText && part.argsText !== "{}" && <><p className="muted">Arguments</p><pre className="mono">{pretty(part.argsText)}</pre></>}
        {!pending && <><p className="muted">{failed ? "Error" : "Result"}</p><pre className="mono">{String(part.result)}</pre></>}
      </details>
    </Card>
  );
}
