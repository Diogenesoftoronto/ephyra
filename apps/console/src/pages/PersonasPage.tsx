import { useState } from "react";
import type { PersonaId } from "@ephyra/core";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { PageHeader, Skeleton } from "../kit.ts";
import { Load } from "../components/Load.tsx";
import { PersonaCard } from "../components/PersonaCard.tsx";
import { useNow } from "../lib/clock.tsx";
import "./PersonasPage.css";

const DAY = 86_400_000;

/** The six roles in the loop: who does what, what they did lately, and what that cost over two weeks. */
export function PersonasPage() {
  const [selected, setSelected] = useState<PersonaId | null>(null);
  const api = useApi();
  const now = useNow(60_000);
  const personas = useAsync(() => api.personas(), "personas");
  const activity = useAsync(() => api.activity(100), "personas:activity");
  const from = new Date(Math.floor(now / DAY) * DAY - 13 * DAY).toISOString();
  const usage = useAsync(() => api.usage({ from }), `personas:usage:${from}`);
  return (
    <div className="page">
      <PageHeader
        title="Personas"
        lede="A persona is a role in the loop, not a model. Any engine can play it; every number can be read by persona and by engine."
      />
      <Load state={personas.state} retry={personas.reload} skeleton={<Skeleton block />}>
        {(list) => (
          <div className="personas-layout" data-selected={Boolean(selected)}>
            <nav className="persona-directory" aria-label="Persona directory">
              {list.map((p) => (
                <button
                  key={p.id}
                  className="persona-directory-entry"
                  aria-pressed={selected === p.id}
                  onClick={() => setSelected(p.id)}
                >
                  <PersonaAvatar persona={p.id} size={32} />
                  <span>
                    <strong>{p.name}</strong>
                    <span className="muted">{p.role}</span>
                  </span>
                </button>
              ))}
            </nav>
            <section className="persona-detail">
              {selected && (
                <button className="ui-button ui-button--ghost persona-back" onClick={() => setSelected(null)}>
                  ← All personas
                </button>
              )}
              {list
                .filter((p) => p.id === selected)
                .map((p) => (
                  <PersonaCard
                    key={p.id}
                    persona={p}
                    recent={
                      activity.state.status === "ready"
                        ? activity.state.data.filter((a) => a.persona === p.id)
                        : []
                    }
                    totals={
                      usage.state.status === "ready"
                        ? usage.state.data.byPersona.find((g) => g.key === p.id)?.totals
                        : undefined
                    }
                    activityUnavailable={activity.state.status !== "ready"}
                    usageUnavailable={usage.state.status !== "ready"}
                  />
                ))}
              {!selected && (
                <p className="muted">Choose a persona to see its role, recent work and recorded spend.</p>
              )}
            </section>
          </div>
        )}
      </Load>
    </div>
  );
}
