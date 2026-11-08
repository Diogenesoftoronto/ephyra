import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, Notice, PageHeader, Skeleton, Stats, Stat } from "../kit.ts";
import { ActivityFeed } from "../components/ActivityFeed.tsx";
import { Load } from "../components/Load.tsx";
import { SpendByDay } from "../components/SpendByDay.tsx";
import { TrailBudgets } from "../components/TrailBudgets.tsx";
import { WaitingList } from "../components/WaitingList.tsx";
import { formatMicrousd } from "../lib/format.ts";
import { ExceptionNotice } from "../components/ExceptionNotice.tsx";
import "./OverviewPage.css";

/**
 * What needs you first. The order follows the work: an exception, the decisions waiting (the one framed tray), what is
 * running, then the numbers and the money. Each part loads and fails on its own.
 */
export function OverviewPage() {
  const api = useApi();
  const activity = useAsync(() => api.activity(30), "overview:activity");
  const inbox = useAsync(() => api.inbox(), "overview:inbox");
  const usage = useAsync(() => api.usage(), "overview:usage");
  const runs = useAsync(() => api.runs({ limit: 20 }), "overview:runs");
  const refresh = () => {
    activity.reload();
    inbox.reload();
    usage.reload();
    runs.reload();
  };
  const waiting =
    inbox.state.status === "ready"
      ? inbox.state.data.filter((i) => i.kind === "checkpoint" || i.kind === "spend").length
      : null;
  const running =
    activity.state.status === "ready"
      ? activity.state.data.filter((a) => a.status === "running").length
      : null;
  const pending = [activity.state, inbox.state, usage.state, runs.state].some(
    (state) => state.status === "loading" || (state.status === "ready" && state.refreshing),
  );
  const finished = activity.state.status === "ready"
    ? activity.state.data.filter((item) => item.status === "done" || item.status === "failed").slice(0, 3)
    : [];
  const lede = [
    waiting === null ? null : `${waiting} decision${waiting === 1 ? "" : "s"} waiting`,
    running === null ? null : `${running} agent${running === 1 ? "" : "s"} running`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="page overview">
      <PageHeader
        title="Overview"
        lede={lede || "Decisions, active work and recorded costs for this deployment."}
        actions={
          <Button size="sm" onClick={refresh} loading={pending}>
            {pending ? "Updating…" : "Refresh"}
          </Button>
        }
      />
      {runs.state.status === "ready" && <ExceptionNotice runs={runs.state.data} />}
      {runs.state.status === "error" && (
        <Notice
          tone="warn"
          title="Runs could not be loaded"
          body="The exception check did not run."
          actions={
            <Button size="sm" onClick={runs.reload}>
              Try again
            </Button>
          }
        />
      )}
      <div className="overview__work">
        <Card
          tone="tray"
          title="Needs your decision"
          meta={waiting === null ? undefined : `${waiting} waiting`}
          actions={
            <a className="ui-button ui-button--sm ui-button--ghost" href="#/inbox">
              Open inbox
            </a>
          }
        >
          <Load state={inbox.state} retry={inbox.reload} skeleton={<Skeleton lines={4} />}>
            {(items) => <WaitingList items={items} />}
          </Load>
        </Card>
        <div className="overview__activity">
          <Card
            tone="quiet"
            title="Working now"
            meta={running === null ? undefined : `${running} agent${running === 1 ? "" : "s"}`}
            actions={
              <a className="ui-button ui-button--sm ui-button--ghost" href="#/runs">
                All runs
              </a>
            }
          >
            <Load state={activity.state} retry={activity.reload} skeleton={<Skeleton lines={4} />}>
              {(items) => (
                <ActivityFeed items={items.filter((a) => a.status === "running" || a.status === "waiting")} />
              )}
            </Load>
          </Card>
          {finished.length > 0 && (
            <Card tone="quiet" title="Recently finished">
              <ActivityFeed items={finished} />
              <a className="ui-label overview__more" href="#/runs">View run history <span aria-hidden="true">→</span></a>
            </Card>
          )}
        </div>
      </div>
      <Load state={usage.state} retry={usage.reload} skeleton={<Skeleton block />}>
        {(u) => (
          <section className="overview__usage" aria-label="Recorded usage">
            <Stats>
              <Stat
                label="Recorded spend, 7 days"
                value={formatMicrousd(u.totals.costMicrousd)}
                unknownCount={u.totals.unknownCost}
              />
              <Stat
                label="Recorded work entries"
                value={u.totals.entries}
                sub={`${u.totals.failed} failed · ${u.totals.unavailable} unavailable`}
                tone={u.totals.failed ? "bad" : undefined}
              />
              <Stat label="Trails that spent" value={u.byTrail.length} />
              <Stat
                label="Budget used"
                value={`${u.totals.unknownCost ? "At least " : ""}${Math.round(
                  (100 * u.byTrail.reduce((n, t) => n + t.budget.spendMicrousdUsed, 0)) /
                    Math.max(
                      1,
                      u.byTrail.reduce((n, t) => n + t.budget.spendMicrousdMax, 0),
                    ),
                )}%`}
                sub="lifetime usage of the listed trails"
              />
            </Stats>
            <div className="two-col">
              <Card
                tone="quiet"
                title="Recorded spend"
                meta="Last 7 days"
                actions={
                  <a className="ui-button ui-button--sm ui-button--ghost" href="#/usage">
                    Usage
                  </a>
                }
              >
                <SpendByDay days={u.byDay} />
              </Card>
              <Card tone="quiet" title="Trail budgets" meta="Highest usage first"
                actions={<a className="ui-button ui-button--sm ui-button--ghost" href="#/usage">All budgets</a>}>
                <TrailBudgets trails={u.byTrail} limit={3} />
                {u.byTrail.length > 3 && <p className="ui-label">Showing 3 of {u.byTrail.length} trails. <a href="#/usage">View all trail budgets</a>.</p>}
              </Card>
            </div>
          </section>
        )}
      </Load>
    </div>
  );
}
