import { useEffect, useState } from "react";
import { PERSONAS, type ActivityItem, type UsageSummary } from "@ephyra/core";
import { ConsoleClient } from "../api.ts";

type Page = "Overview" | "Usage" | "Inbox" | "Workspace" | "Personas";
const pages: Page[] = ["Overview", "Usage", "Inbox", "Workspace", "Personas"];
const money = (n: number) => `$${(n / 1_000_000).toFixed(2)}`;
export function App({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const [page, setPage] = useState<Page>("Overview");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const client = new ConsoleClient(location.origin, sessionStorage.getItem("ephyra-token") ?? "", fetcher);
    Promise.all([client.activity(), client.usage()]).then(([a, u]) => { setActivity(a); setUsage(u); })
      .catch(() => setError("Could not load console data. Check your session and try again."))
      .finally(() => setLoading(false));
  }, [fetcher]);
  return <div className="shell"><header><strong>Ephyra</strong><a href="/auth/login">Sign in</a></header>
    <nav aria-label="Console">{pages.map(p => <button key={p} aria-current={page === p ? "page" : undefined}
      onClick={() => setPage(p)}>{p}</button>)}</nav><main><h1>{page}</h1>
      {loading && <p role="status">Loading console data…</p>}{error && <p role="alert">{error}</p>}
      {page === "Overview" && <><h2>Activity</h2>{activity.length === 0 && !loading && <p>No activity available.</p>}
        <ul>{activity.map(a => <li key={a.id}>{a.summary} <small>{a.status}</small></li>)}</ul>
        <h2>Spend this week</h2><p>{usage ? money(usage.totals.costMicrousd) : "Unavailable"}</p>
        {usage && usage.totals.unknownCost > 0 && <p>{usage.totals.unknownCost} unknown costs</p>}</>}
      {page === "Usage" && <><h2>Totals</h2><p>{usage ? money(usage.totals.costMicrousd) : "Unavailable"}</p>
        {usage && <><p>{usage.totals.unknownCost} unknown costs · {usage.totals.failed} failed ·
          {usage.totals.unavailable} unavailable</p><h2>By engine</h2>
          <ul>{usage.byEngine.map(g => <li key={g.key}>{g.key}: {money(g.totals.costMicrousd)}
            {g.totals.unknownCost > 0 && ` · ${g.totals.unknownCost} unknown`}</li>)}</ul></>}</>}
      {page === "Personas" && <div className="people">{PERSONAS.map(p => <article key={p.id}>
        <div className={`avatar ${p.id}`}>{p.name[0]}</div><h2>{p.name} <small>{p.role}</small></h2>
        <p>{p.blurb}</p><p><small>Named for {p.namesake}</small></p></article>)}</div>}
      {(page === "Inbox" || page === "Workspace") && <p>This view is not yet available.</p>}
    </main></div>;
}
