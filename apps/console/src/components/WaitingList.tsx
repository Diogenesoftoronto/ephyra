import { Badge, Checkpoint, Empty, Row, Rows } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import type { InboxEntry } from "../api.ts";
import { checkpointName } from "../ui/primitives.tsx";

export const itemLabel = (i: InboxEntry): string =>
  i.kind === "checkpoint"
    ? `Checkpoint ${i.checkpoint}`
    : i.kind === "spend"
      ? "Spend request"
      : i.kind === "parked"
        ? "Parked"
        : "Notice";

/** The lead of an inbox row: the lettered checkpoint tile, or a label for the other kinds. */
export function ItemLead({ item }: { item: InboxEntry }) {
  return item.kind === "checkpoint" && item.checkpoint ? (
    <Checkpoint id={item.checkpoint} blocking={item.blocking} compact />
  ) : (
    <span className="ui-checkpoint ui-checkpoint--compact">
      <i aria-hidden="true">{item.kind === "spend" ? "$" : item.kind === "parked" ? "Ⅱ" : "i"}</i>
      <span className="sr-only">{itemLabel(item)}</span>
    </span>
  );
}

export const itemStep = (i: InboxEntry): string =>
  i.kind === "checkpoint" && i.checkpoint
    ? checkpointName(i.checkpoint)
    : i.kind === "spend"
      ? "Spend request"
      : i.kind === "parked"
        ? "Parked"
        : "Notice";

/** What is waiting on a person, as the decision rows of the Overview. */
export function WaitingList({ items, limit = 5 }: { items: InboxEntry[]; limit?: number }) {
  const now = useNow(60_000);
  const waiting = items
    .filter((i) => i.kind === "checkpoint" || i.kind === "spend")
    .sort(
      (a, b) =>
        Number(b.blocking) - Number(a.blocking) ||
        b.severity - a.severity ||
        a.createdAt.localeCompare(b.createdAt),
    );
  if (waiting.length === 0)
    return <Empty title="Nothing is waiting for you" body="Approvals and spend requests appear here." />;
  return (
    <Rows>
      {waiting.slice(0, limit).map((i) => (
        <Row
          key={`${i.trailId}-${i.kind}-${i.checkpoint ?? ""}`}
          lead={<ItemLead item={i} />}
          title={i.title}
          meta={
            <>
              {itemStep(i)} · <span className="mono">{i.short}</span> · {i.area} · rev {i.bound.rev}
              {i.bound.head && (
                <>
                  {" "}
                  · <span className="mono">{i.bound.head.slice(0, 7)}</span>
                </>
              )}
              <br />
              <Badge tone={i.risk === "critical" ? "bad" : i.risk === "high" ? "warn" : "neutral"}>
                {i.risk} risk
              </Badge>
              {" · "}
              {i.blocking ? "Blocking" : "Advisory"} · requested {relativeTime(i.createdAt, now)}
            </>
          }
          aside={
            <a
              href={`#/inbox/${i.trailId}`}
              className={`ui-button ui-button--sm ui-button--${i.blocking ? "primary" : "secondary"}`}
            >
              Review
            </a>
          }
        />
      ))}
      {waiting.length > limit && <Row title={<a href="#/inbox">and {waiting.length - limit} more</a>} />}
    </Rows>
  );
}
