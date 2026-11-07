import type { ActivityItem } from "@ephyra/core";
import { Empty, Row, Rows, Status, Tag } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { Elapsed } from "./Elapsed.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";

export function ActivityRow({ item }: { item: ActivityItem }) {
  const now = useNow(30_000);
  return (
    <Row
      lead={
        item.persona ? (
          <PersonaAvatar persona={item.persona} size={32} live={item.status === "running"} />
        ) : undefined
      }
      title={item.summary}
      meta={
        <>
          {item.trailId ? (
            <a href={`#/inbox/${item.trailId}`} className="mono">
              {item.short}
            </a>
          ) : null}
          {item.engine ? (
            <>
              {" "}
              · <Tag>{item.engine}</Tag>
            </>
          ) : null}
          {" · "}
          {item.status === "running" && item.startedAt ? (
            <>
              for <Elapsed since={item.startedAt} />
            </>
          ) : (
            relativeTime(item.at, now)
          )}
        </>
      }
      aside={<Status state={item.status} />}
    />
  );
}

export function ActivityFeed({
  items,
  empty = "Nothing is running right now.",
}: {
  items: ActivityItem[];
  empty?: string;
}) {
  if (items.length === 0)
    return <Empty title={empty} body="When an agent starts work on a trail, it shows up here." />;
  return (
    <Rows>
      {items.map((i) => (
        <ActivityRow key={i.id} item={i} />
      ))}
    </Rows>
  );
}
