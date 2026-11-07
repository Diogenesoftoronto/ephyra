import { useMemo, useState } from "react";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Badge, Button, Card, PageHeader, Skeleton } from "../kit.ts";
import { Load } from "../components/Load.tsx";
import { noRunFilters, RunFilters, type RunFilterValue } from "../components/RunFilters.tsx";
import { RunList } from "../components/RunList.tsx";
import "./RunsPage.css";

/** Every running and recent agent run, wherever it executes: Amp orbs and runners, local processes, sandboxes. */
export function RunsPage() {
  const api = useApi();
  const runs = useAsync(() => api.runs({ limit: 100 }), "runs");
  const [filters, setFilters] = useState<RunFilterValue>(noRunFilters);
  return (
    <div className="page">
      <PageHeader title="Runs" lede="The live view of the agent harness: what is running, where, and what it did."
        actions={<Button size="sm" onClick={runs.reload}>Refresh</Button>} />
      <Load state={runs.state} retry={runs.reload} skeleton={<Skeleton lines={6} />}>
        {(all) => <RunsBody all={all} filters={filters} setFilters={setFilters} />}
      </Load>
    </div>
  );
}

function RunsBody({ all, filters, setFilters }: {
  all: Awaited<ReturnType<ReturnType<typeof useApi>["runs"]>>; filters: RunFilterValue; setFilters: (v: RunFilterValue) => void;
}) {
  const trails = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of all) if (r.trailId && r.short) seen.set(r.trailId, r.short);
    return [...seen].map(([id, short]) => ({ id, short }));
  }, [all]);
  const shown = all.filter((r) => (!filters.trail || r.trailId === filters.trail) && (!filters.persona || r.persona === filters.persona)
    && (!filters.executor || r.executor.kind === filters.executor));
  const running = all.filter((r) => r.status === "running").length;
  return (
    <>
      <div className="runs-summary">
        <Badge tone={running ? "live" : "neutral"}>{running} running</Badge>
        <Badge tone="bad">{all.filter((r) => r.status === "failed").length} failed</Badge>
        <Badge tone="warn">{all.filter((r) => r.status === "unavailable").length} unavailable</Badge>
      </div>
      <Card><RunFilters value={filters} trails={trails} onChange={setFilters} /></Card>
      <RunList runs={shown} empty={all.length === 0 ? "No runs yet." : "No runs match these filters."} />
    </>
  );
}
