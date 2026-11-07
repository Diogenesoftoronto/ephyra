import { Badge, Empty } from "../kit.ts";
import type { InboxEntry } from "../api.ts";
import "./WaitingList.css";

export const itemLabel = (i: InboxEntry): string =>
  i.kind === "checkpoint" ? `Checkpoint ${i.checkpoint}` : i.kind === "spend" ? "Spend request" : i.kind === "parked" ? "Parked" : "Notice";

export function WaitingList({ items, limit = 5 }: { items: InboxEntry[]; limit?: number }) {
  const waiting = items.filter((i) => i.kind === "checkpoint" || i.kind === "spend");
  if (waiting.length === 0) return <Empty title="Nothing is waiting for you" body="Approvals and spend requests appear here." />;
  return (
    <ul className="waiting" aria-label="Waiting for you">
      {waiting.slice(0, limit).map((i) => (
        <li key={`${i.trailId}-${i.kind}-${i.checkpoint ?? ""}`}>
          <a href={`#/inbox/${i.trailId}`} className="waiting-link">
            <Badge tone={i.blocking ? "warn" : "info"}>{itemLabel(i)}</Badge>
            <span className="waiting-title">{i.title}</span>
            <span className="mono muted">{i.short}</span>
          </a>
        </li>
      ))}
      {waiting.length > limit && <li><a href="#/inbox">and {waiting.length - limit} more</a></li>}
    </ul>
  );
}
