import { Badge, Empty } from "../kit.ts";
import type { InboxEntry } from "../api.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { itemLabel } from "./WaitingList.tsx";
import "./InboxList.css";

const TONE = { critical: "bad", high: "warn", medium: "info", low: "neutral" } as const;

/** One row per thing waiting on a person. The selected row stays marked so the detail beside it has context. */
export function InboxList({ items, selected }: { items: InboxEntry[]; selected?: string | null }) {
  const now = useNow(30_000);
  if (items.length === 0) return <Empty title="Inbox is empty" body="Checkpoints, spend requests and parked trails appear here." />;
  return (
    <ul className="inbox-list" aria-label="Inbox">
      {items.map((i) => (
        <li key={`${i.trailId}-${i.kind}-${i.checkpoint ?? ""}`}>
          <a href={`#/inbox/${i.trailId}`} className="inbox-row" aria-current={selected === i.trailId ? "true" : undefined}>
            <span className="inbox-row-top">
              <Badge tone={i.blocking ? "warn" : "info"}>{itemLabel(i)}</Badge>
              <Badge tone={TONE[i.risk]}>{i.risk}</Badge>
              {i.shadowVerdict === "approve" && <Badge tone="ok">would auto-approve</Badge>}
              <span className="mono muted">{i.short}</span>
              <span className="muted inbox-row-time">{relativeTime(i.createdAt, now)}</span>
            </span>
            <span className="inbox-row-title">{i.title}</span>
            <span className="muted inbox-row-sum">{i.artefact.summary}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
