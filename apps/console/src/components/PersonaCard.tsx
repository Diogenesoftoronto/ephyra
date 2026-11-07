import type { ActivityItem, Persona, UsageTotals } from "@ephyra/core";
import { Badge, Card, Empty, PersonaTag, Tag } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { TotalCost } from "./Cost.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import "./PersonaCard.css";

/** A persona: its face, its role, who it is named for, what it does, what it did lately and what that cost. */
export function PersonaCard({ persona, recent, totals }: { persona: Persona; recent: ActivityItem[]; totals?: UsageTotals }) {
  const now = useNow(60_000);
  const running = recent.some((a) => a.status === "running");
  return (
    <Card className="persona-card">
      <div className="persona-head">
        <PersonaAvatar persona={persona.id} size={96} live={running} />
        <div>
          <h2 className="persona-name"><PersonaTag persona={persona.id}>{persona.name}</PersonaTag></h2>
          <p><strong>{persona.role}</strong></p>
          <p className="muted persona-namesake">Named for {persona.namesake}.</p>
        </div>
      </div>
      <p>{persona.blurb}</p>
      <p className="persona-does" aria-label="What it does">{persona.does.map((d) => <Tag key={d}>{d}</Tag>)}</p>
      <section aria-label={`${persona.name}'s recent activity`}>
        <h3>Recent</h3>
        {recent.length === 0 ? <Empty title="Nothing lately" /> : (
          <ul className="persona-recent">
            {recent.slice(0, 3).map((a) => (
              <li key={a.id}><Badge tone={a.status === "running" ? "live" : a.status === "failed" ? "bad" : a.status === "waiting" ? "warn" : "ok"}>{a.status}</Badge>
                <span>{a.summary}</span><span className="muted">{relativeTime(a.at, now)}</span></li>
            ))}
          </ul>
        )}
      </section>
      <p className="persona-spend">
        {totals ? <>Spend, last 14 days: <TotalCost totals={totals} />{totals.failed + totals.unavailable > 0 && <> · <span className="muted">{totals.failed} failed, {totals.unavailable} unavailable</span></>}</>
          : <span className="muted">No spend recorded.</span>}
      </p>
    </Card>
  );
}
