import type { ActivityItem } from "@ephyra/core";
import { Empty, Row, Rows, Status } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { Elapsed } from "./Elapsed.tsx";
import { EngineBadge } from "./EngineBadge.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import "./ActivityFeed.css";

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
        <span className="activity-meta">
          {item.trailId ? (
            <a href={`#/inbox/${item.trailId}`} className="mono">
              {item.short}
            </a>
          ) : null}
          {item.engine && <span className="activity-meta__engine"><EngineBadge engine={item.engine} /></span>}
          <span>
            {item.status === "running" && item.startedAt ? (
              <>
                for <Elapsed since={item.startedAt} />
              </>
            ) : (
              relativeTime(item.at, now)
            )}
          </span>
        </span>
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
    return <Empty title={empty} body="When an agent starts work on a quest, it shows up here." />;
  return (
    <Rows>
      {items.map((i) => (
        <ActivityRow key={i.id} item={i} />
      ))}
    </Rows>
  );
}
