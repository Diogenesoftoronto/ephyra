import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, PageHeader, Skeleton } from "../kit.ts";
import { ActivityFeed } from "../components/ActivityFeed.tsx";
import { Load } from "../components/Load.tsx";
import { WaitingList } from "../components/WaitingList.tsx";
import { WeekSpend } from "../components/WeekSpend.tsx";
import "./OverviewPage.css";

/** What is running, what is waiting for you, and what this week cost. Each card loads and fails on its own. */
export function OverviewPage() {
  const api = useApi();
  const activity = useAsync(() => api.activity(30), "overview:activity");
  const inbox = useAsync(() => api.inbox(), "overview:inbox");
  const usage = useAsync(() => api.usage(), "overview:usage");
  const refresh = () => { activity.reload(); inbox.reload(); usage.reload(); };
  return (
    <div className="page">
      <PageHeader title="Overview" lede="What the agents are doing now, what needs you, and what it costs."
        actions={<Button size="sm" onClick={refresh}>Refresh</Button>} />
      <div className="overview-grid">
        <Card title="Running now" tone="live" className="overview-running">
          <Load state={activity.state} retry={activity.reload} skeleton={<Skeleton lines={4} />}>
            {(items) => <ActivityFeed items={items.filter((a) => a.status === "running" || a.status === "waiting")} />}
          </Load>
        </Card>
        <Card title="Waiting for you" actions={<a href="#/inbox">Open inbox</a>}>
          <Load state={inbox.state} retry={inbox.reload} skeleton={<Skeleton lines={3} />}>{(items) => <WaitingList items={items} />}</Load>
        </Card>
        <Card title="Spend this week" actions={<a href="#/usage">Usage</a>}>
          <Load state={usage.state} retry={usage.reload} skeleton={<Skeleton lines={3} />}>{(u) => <WeekSpend usage={u} />}</Load>
        </Card>
        <Card title="Recently finished" className="overview-recent">
          <Load state={activity.state} retry={activity.reload} skeleton={<Skeleton lines={3} />}>
            {(items) => <ActivityFeed items={items.filter((a) => a.status === "done" || a.status === "failed").slice(0, 5)} empty="Nothing finished yet." />}
          </Load>
        </Card>
      </div>
    </div>
  );
}
