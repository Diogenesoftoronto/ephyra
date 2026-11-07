import type {
  DataMessagePartProps,
  ReasoningGroupProps,
  ReasoningMessagePartProps,
} from "@assistant-ui/react";
import { Badge, Tag } from "../kit.ts";
import { clockTime, safeHref } from "../lib/format.ts";
import { PolicyBadge } from "./ToolCard.tsx";
import type { PolicyNote } from "./messages.ts";

/** Reasoning stays collapsed: it is the model's summary of its thinking, not the record of what happened. */
export function ReasoningGroup({ children }: ReasoningGroupProps) {
  return (
    <details className="reasoning">
      <summary>
        <Tag>reasoning</Tag> <span className="muted">show</span>
      </summary>
      {children}
    </details>
  );
}

export function ReasoningText({ text }: ReasoningMessagePartProps) {
  return <p className="muted">{text}</p>;
}

export function StatusLine({ data }: DataMessagePartProps<{ text: string; at: string }>) {
  return (
    <p className="run-line">
      <Badge tone="info">status</Badge> <span>{data.text}</span>{" "}
      <span className="muted mono">{clockTime(data.at)}</span>
    </p>
  );
}

export function PortalLine({ data }: DataMessagePartProps<{ url: string; text?: string; at: string }>) {
  const href = safeHref(data.url);
  return (
    <p className="run-line">
      <Badge tone="info">preview</Badge>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {data.text || "Live preview"} ↗
        </a>
      ) : (
        <span>{data.text || "Live preview"}</span>
      )}
      <span className="muted mono">{clockTime(data.at)}</span>
    </p>
  );
}

/** A decision whose tool call is not in the transcript (for example one that was rejected before it was recorded). */
export function PolicyLine({ data }: DataMessagePartProps<PolicyNote & { tool?: string; at: string }>) {
  return (
    <p className="run-line">
      {data.tool && <span className="mono">{data.tool}</span>}
      <PolicyBadge policy={data} />
    </p>
  );
}
