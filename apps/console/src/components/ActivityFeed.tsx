import type { ActivityItem } from "@ephyra/core";
import { Badge, Empty, Tag } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { Elapsed } from "./Elapsed.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import "./ActivityFeed.css";

const TONE = { running: "live", waiting: "warn", failed: "bad", done: "ok" } as const;

export function ActivityRow({ item }: { item: ActivityItem }) {
  const now = useNow(30_000);
  const persona = item.persona;
  return (
    <li className="activity-row" data-status={item.status}>
      {persona ? <PersonaAvatar persona={persona} size={32} live={item.status === "running"} /> : <span className="activity-noface" aria-hidden />}
      <div className="activity-main">
        <p>{item.summary}</p>
        <p className="activity-meta muted">
          {item.trailId && <a href={`#/inbox/${item.trailId}`} className="mono">{item.short}</a>}
          {item.engine && <Tag>{item.engine}</Tag>}
          <span>{item.status === "running" && item.startedAt ? <>running for <Elapsed since={item.startedAt} /></> : relativeTime(item.at, now)}</span>
        </p>
      </div>
      <Badge tone={TONE[item.status]}>{item.status}</Badge>
    </li>
  );
}

export function ActivityFeed({ items, empty = "Nothing is running right now." }: { items: ActivityItem[]; empty?: string }) {
  if (items.length === 0) return <Empty title={empty} body="When an agent starts work on a trail, it shows up here." />;
  return <ul className="activity-feed" aria-label="Activity">{items.map((i) => <ActivityRow key={i.id} item={i} />)}</ul>;
}
