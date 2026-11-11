import { useEffect, useMemo, useRef, useState } from "react";
import { PERSONAS, type UsageEntry } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Card, PageHeader, Segmented, Skeleton, Tag } from "../kit.ts";
import { BreakdownTable } from "../components/BreakdownTable.tsx";
import { Ledger, matchesOutcome, noFilters, type LedgerFilterValue } from "../components/Ledger.tsx";
import { LedgerFilters } from "../components/LedgerFilters.tsx";
import { Load } from "../components/Load.tsx";
import { PersonaLabel } from "../components/PersonaLabel.tsx";
import { CostDrivers, OutcomesCoverage, SpendPace } from "../components/UsageCharts.tsx";
import { ForecastPanel } from "../components/ForecastPanel.tsx";
import { Referable } from "../velum/VelumProvider.tsx";
import type { UsageForecast } from "@ephyra/core";
import { TrailBudgets } from "../components/TrailBudgets.tsx";
import { UsageStats } from "../components/UsageStats.tsx";
import { useNow } from "../lib/clock.tsx";
import "./UsagePage.css";

const DAY = 86_400_000;

/**
 * Where the money and time went: totals, spend by day, by persona, by engine and by trail, trail budgets, and a ledger of
 * every unit of work. Unknown costs are counted, never added as zero; failed and unavailable work is listed.
 */
export function UsagePage({ scope = "deployment" }: { scope?: string }) {
  const api = useApi();
  const now = useNow(60_000);
  const [days, setDays] = useState<7 | 14>(7);
  const [filters, setFilters] = useState<LedgerFilterValue>(noFilters);
  const range = useMemo(() => {
    const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
    return { from: new Date(start).toISOString(), to: new Date(now).toISOString() };
  }, [days, Math.floor(now / DAY)]); // eslint-disable-line react-hooks/exhaustive-deps
  const usage = useAsync(() => api.usage(range), `usage:${range.from}`);
  const [forecast, setForecast] = useState<Extract<UsageForecast, { status: "ok" }> | null>(null);
  const today = new Date(now).toISOString().slice(0, 10);
  const span = { from: range.from.slice(0, 10), to: today };
  const query = {
    ...range,
    ...(filters.persona ? { persona: filters.persona as never } : {}),
    ...(filters.engine ? { engine: filters.engine } : {}),
    ...(filters.trail ? { trail: filters.trail } : {}),
  };
  const key = JSON.stringify(query);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [reloadLedger, setReloadLedger] = useState(0);

  const [rows, setRows] = useState<UsageEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [ledger, setLedger] = useState<"loading" | "ready" | "more" | { error: unknown }>("loading");
  useEffect(() => {
    let live = true;
    setLedger("loading");
    api.entries({ ...query, limit: 25 }).then(
      (p) => {
        if (live) {
          setRows(p.entries);
          setCursor(p.cursor);
          setLedger("ready");
        }
      },
      (error: unknown) => {
        if (live) setLedger({ error });
      },
    );
    return () => {
      live = false;
    };
  }, [api, key, reloadLedger]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = async () => {
    setLedger("more");
    try {
      const p = await api.entries({ ...query, limit: 25, cursor });
      if (currentKey.current !== key) return;
      setRows((r) => [...r, ...p.entries]);
      setCursor(p.cursor);
      setLedger("ready");
    } catch (error) {
      if (currentKey.current === key) setLedger({ error });
    }
  };
  const shown = rows.filter((e) => matchesOutcome(e, filters.outcome));
  const loaded = usage.state.status === "ready" ? usage.state.data : null;

  return (
    <div className="page">
      <PageHeader
        title="Usage"
        lede="Every unit of agent work, what it cost, and what could not be priced."
        actions={
          <Segmented
            label="Window"
            value={String(days)}
            onChange={(id) => setDays(id === "14" ? 14 : 7)}
            options={[
              { id: "7", label: "7 days" },
              { id: "14", label: "14 days" },
            ]}
          />
        }
      />
      <Load state={usage.state} retry={usage.reload} skeleton={<Skeleton block />}>
        {(u) => (
          <>
            <UsageStats totals={u.totals} />
            <Referable
              id="usage:spend"
              refData={{ kind: "usage", facet: forecast ? "forecast" : "cumulative", ...span }}
              label={`Spending pace, ${days} days${forecast ? " with forecast" : ""}`}
              href="#/usage"
            >
              <Card
                tone="quiet"
                title="Spending pace"
                meta={`Last ${days} UTC days · recorded spend and running total`}
              >
                <SpendPace days={u.byDay} today={today} forecast={forecast} />
                <ForecastPanel now={now} scope={scope} onForecast={setForecast} />
              </Card>
            </Referable>
            <div className="usage-breakdowns">
              <Referable
                id="usage:drivers"
                refData={{ kind: "usage", facet: "drivers", ...span }}
                label={`Cost drivers, ${days} days`}
                href="#/usage"
              >
                <Card
                  tone="quiet"
                  title="What drove cost"
                  meta="Largest recorded cost first. Select one to filter the ledger."
                >
                  <div className="usage-drivers">
                    <h3>By persona</h3>
                    <CostDrivers
                      title="Persona"
                      groups={u.byPersona.map((g) => ({ key: g.key ?? "unattributed", totals: g.totals }))}
                      render={(k) => <PersonaLabel persona={k === "unattributed" ? null : (k as never)} />}
                      selected={filters.persona || null}
                      onSelect={(k) => setFilters({ ...filters, persona: k ?? "" })}
                    />
                    <h3>By engine</h3>
                    <CostDrivers
                      title="Engine"
                      groups={u.byEngine}
                      selected={filters.engine || null}
                      onSelect={(k) => setFilters({ ...filters, engine: k ?? "" })}
                    />
                  </div>
                </Card>
              </Referable>
              <Referable
                id="usage:outcomes"
                refData={{ kind: "usage", facet: "outcomes", ...span }}
                label={`Outcomes and cost coverage, ${days} days`}
                href="#/usage"
              >
                <Card
                  tone="quiet"
                  title="Outcomes and coverage"
                  meta="Failed and unavailable work, and how much had a price"
                >
                  <OutcomesCoverage days={u.byDay} totals={u.totals} today={today} />
                </Card>
              </Referable>
            </div>
            <details className="usage-tables">
              <summary>Breakdown tables: persona, engine and quest</summary>
              <div className="usage-breakdowns">
                <Card tone="quiet" title="By persona">
                  <BreakdownTable
                    title="Persona"
                    selected={filters.persona || null}
                    onSelect={(k) => setFilters({ ...filters, persona: k ?? "" })}
                    rows={u.byPersona.map((g) => ({
                      key: g.key ?? "unattributed",
                      totals: g.totals,
                      label: <PersonaLabel persona={g.key} />,
                    }))}
                  />
                </Card>
                <Card tone="quiet" title="By engine">
                  <BreakdownTable
                    title="Engine"
                    selected={filters.engine || null}
                    onSelect={(k) => setFilters({ ...filters, engine: k ?? "" })}
                    rows={u.byEngine.map((g) => ({ key: g.key, totals: g.totals, label: <Tag>{g.key}</Tag> }))}
                  />
                </Card>
                <Card tone="quiet" title="By quest">
                  <BreakdownTable
                    title="Quest"
                    selected={filters.trail || null}
                    onSelect={(k) => setFilters({ ...filters, trail: k ?? "" })}
                    rows={u.byTrail.map((t) => ({
                      key: t.trailId,
                      totals: t.totals,
                      label: (
                        <span>
                          <span className="mono">{t.short}</span> {t.title}
                        </span>
                      ),
                    }))}
                  />
                </Card>
              </div>
            </details>
            <Card tone="quiet" title="Quest budgets">
              <TrailBudgets trails={u.byTrail} />
            </Card>
          </>
        )}
      </Load>
      <Card tone="quiet" title="Ledger" meta="Newest first. Selecting a row above filters this table.">
        <div className="stack">
          <LedgerFilters
            value={filters}
            onChange={setFilters}
            engines={loaded?.byEngine.map((g) => g.key) ?? []}
            trails={loaded?.byTrail.map((t) => ({ id: t.trailId, short: t.short })) ?? []}
          />
          {ledger === "loading" ? (
            <Skeleton lines={5} />
          ) : typeof ledger === "object" ? (
            <Load state={{ status: "error", error: ledger.error }} retry={() => setReloadLedger((n) => n + 1)}>
              {() => null}
            </Load>
          ) : (
            <Ledger
              entries={shown}
              hasMore={Boolean(cursor)}
              loadingMore={ledger === "more"}
              onMore={() => void more()}
            />
          )}
        </div>
      </Card>
      <p className="muted usage-foot">
        Personas: {PERSONAS.map((p) => p.name).join(", ")}. Cost shows “unknown” when an engine did not report one.
      </p>
    </div>
  );
}
