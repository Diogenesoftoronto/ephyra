import { useEffect, useMemo, useState } from "react";
import { PERSONAS } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, PageHeader, Skeleton, Status } from "../kit.ts";
import { Load } from "../components/Load.tsx";
import { noRunFilters, RunFilters, type RunFilterValue } from "../components/RunFilters.tsx";
import { RunList } from "../components/RunList.tsx";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import "./RunsPage.css";

/** Every running and recent agent run, wherever it executes: Amp orbs and runners, local processes, sandboxes. */
export function RunsPage() {
  const api = useApi();
  const runs = useAsync(() => api.runs({ limit: 100 }), "runs");
  const [filters, setFilters] = useState<RunFilterValue>(() => ({
    ...noRunFilters,
    persona: new URLSearchParams(location.hash.split("?")[1]).get("persona") ?? "",
  }));
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") runs.reload(); };
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [runs.reload]);
  return (
    <div className="page">
      <PageHeader
        title="Runs"
        lede="Follow agent work, see which engines are running, and open the record of each step."
        actions={
          <Button size="sm" onClick={runs.reload} disabled={runs.state.status === "ready" && runs.state.refreshing}>
            {runs.state.status === "ready" && runs.state.refreshing ? "Updating…" : "Refresh"}
          </Button>
        }
      />
      <Load state={runs.state} retry={runs.reload} skeleton={<Skeleton lines={6} />}>
        {(all) => <RunsBody all={all} filters={filters} setFilters={setFilters} />}
      </Load>
    </div>
  );
}

function RunsBody({
  all,
  filters,
  setFilters,
}: {
  all: Awaited<ReturnType<ReturnType<typeof useApi>["runs"]>>;
  filters: RunFilterValue;
  setFilters: (v: RunFilterValue) => void;
}) {
  const trails = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all) if (r.trailId && r.short) seen.set(r.trailId, r.short);
    return [...seen].map(([id, short]) => ({ id, short }));
  }, [all]);
  const shown = all.filter(
    (r) =>
      (!filters.trail || r.trailId === filters.trail) &&
      (!filters.persona || r.persona === filters.persona) &&
      (!filters.executor || r.executor.kind === filters.executor),
  );
  const running = all.filter((r) => r.status === "running").length;
  return (
    <>
      <section className="run-roster" aria-label="Agent activity in the latest 100 runs">
        {PERSONAS.map((persona) => {
          const own = all.filter((run) => run.persona === persona.id);
          const working = own.filter((run) => run.status === "running");
          const latest = [...own].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
          return <button key={persona.id} type="button" className="run-roster__agent"
            aria-pressed={filters.persona === persona.id} aria-label={`Filter runs by ${persona.name}`}
            onClick={() => setFilters({ ...filters, persona: filters.persona === persona.id ? "" : persona.id })}>
            <PersonaAvatar persona={persona.id} size={48} live={working.length > 0} />
            <span className="run-roster__identity"><strong>{persona.name}</strong><small>{persona.role}</small></span>
            <span className="run-roster__status">{working.length ? `${working.length} running`
              : latest ? `Last run ${latest.status}` : "No recent run"}</span>
            <span className="run-roster__engine" title={latest?.engine}>{latest?.engine ?? "No engine recorded"}</span>
          </button>;
        })}
      </section>
      <p className="account-hint">Showing the latest 100 runs. Refreshes every five seconds while this page is visible.</p>
      <div className="runs-summary">
        <Status state="running">{running} running</Status>
        <Status state="failed">{all.filter((r) => r.status === "failed").length} failed</Status>
        <Status state="stale">{all.filter((r) => r.status === "unavailable").length} unavailable</Status>
      </div>
      <Card tone="quiet">
        <RunFilters value={filters} trails={trails} onChange={setFilters} />
      </Card>
      <Card tone="quiet" title="Runs" meta={`${shown.length} of ${all.length}`}>
        <RunList runs={shown} empty={all.length === 0 ? "No runs yet." : "No runs match these filters."} />
      </Card>
    </>
  );
}
