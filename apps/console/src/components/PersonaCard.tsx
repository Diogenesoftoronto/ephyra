import type { ActivityItem, Persona, UsageTotals } from "@ephyra/core";
import { Card, Empty, PersonaTag, Status, Tag } from "../kit.ts";
import { relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/clock.tsx";
import { TotalCost } from "./Cost.tsx";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import { EngineBadge } from "./EngineBadge.tsx";
import "./PersonaCard.css";
import "./PersonaMaterial.css";

/** A persona: its face, its role, who it is named for, what it does, what it did lately and what that cost. */
export function PersonaCard({
  persona,
  recent,
  totals,
  activityUnavailable,
  usageUnavailable,
}: {
  persona: Persona;
  recent: ActivityItem[];
  totals?: UsageTotals;
  activityUnavailable?: boolean;
  usageUnavailable?: boolean;
}) {
  const now = useNow(60_000);
  const running = recent.some((a) => a.status === "running");
  const engines = [...new Set(recent.flatMap((a) => a.engine ? [a.engine] : []))];
  return (
    <Card className="persona-card" tone="tray">
      <div className="persona-head persona-material" data-persona={persona.id}>
        <PersonaAvatar persona={persona.id} size={96} live={running} />
        <div>
          <h2 className="persona-name">
            <PersonaTag persona={persona.id} withMark={false}>
              {persona.name}
            </PersonaTag>
          </h2>
          <p>
            <strong>{persona.role}</strong>
          </p>
          <p className="muted persona-namesake">Named for {persona.namesake}.</p>
        </div>
      </div>
      <p>{persona.blurb}</p>
      <p className="persona-does" aria-label="What it does">
        {persona.does.map((d) => (
          <Tag key={d}>{d}</Tag>
        ))}
      </p>
      <section aria-label={`${persona.name}'s recent activity`}>
        <h3>Recent</h3>
        {activityUnavailable ? (
          <p className="muted">Activity has not loaded.</p>
        ) : recent.length === 0 ? (
          <Empty title="Nothing lately" />
        ) : (
          <ul className="persona-recent">
            {recent.slice(0, 3).map((a) => (
              <li key={a.id}>
                <Status state={a.status} />
                <span>{a.summary}</span>
                <span className="muted">{relativeTime(a.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted persona-engines">
        <span>Recorded engines</span>
        {engines.length ? engines.map((engine) => <EngineBadge key={engine} engine={engine} />) : <span>None reported</span>}
      </p>
      <p>
        <a href={persona.id === "velum" ? "#/workspace" : `#/runs?persona=${persona.id}`}>
          {persona.id === "velum" ? "Draft with Velum" : `See ${persona.name}'s runs`}
        </a>
      </p>
      <p className="persona-spend">
        {usageUnavailable ? (
          <span className="muted">Usage has not loaded.</span>
        ) : totals ? (
          <>
            Spend, last 14 days: <TotalCost totals={totals} />
            {totals.failed + totals.unavailable > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="muted">
                  {totals.failed} failed, {totals.unavailable} unavailable
                </span>
              </>
            )}
          </>
        ) : (
          <span className="muted">No spend recorded.</span>
        )}
      </p>
    </Card>
  );
}
