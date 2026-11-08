import { Badge, Empty, Row, Rows } from "../kit.ts";
import type { InboxEntry } from "../api.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { ItemLead, itemStep } from "./WaitingList.tsx";

/** One row per thing waiting on a person. The open trail is marked so the detail beside it has context. */
export function InboxList({ items, selected }: { items: InboxEntry[]; selected?: string | null }) {
  const now = useNow(30_000);
  if (items.length === 0)
    return <Empty title="No quest requests" body="Checkpoints, spend requests and parked quests appear here." />;
  return (
    <Rows>
      {items.map((i) => (
        <Row
          key={`${i.trailId}-${i.kind}-${i.checkpoint ?? ""}`}
          lead={<ItemLead item={i} />}
          title={
            <a href={`#/inbox/${i.trailId}`} aria-current={selected === i.trailId ? "true" : undefined}>
              {i.title}
            </a>
          }
          meta={
            <>
              {itemStep(i)} · <span className="mono">{i.short}</span> · {i.area} · {i.risk} risk ·{" "}
              {relativeTime(i.createdAt, now)}
            </>
          }
          aside={i.shadowVerdict === "approve" ? <Badge tone="ok">would auto-approve</Badge> : undefined}
        />
      ))}
    </Rows>
  );
}
