import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, Empty, PageHeader, Skeleton } from "../kit.ts";
import { InboxList } from "../components/InboxList.tsx";
import { Load } from "../components/Load.tsx";
import { InvestigationQuestions } from "../components/InvestigationQuestions.tsx";
import { TrailPanel } from "./TrailPanel.tsx";
import "./InboxPage.css";

/** The terminal inbox in a browser: what waits on a person, and the trail you have open beside it. */
export function InboxPage({ trailId, canAct = true, principal, questionWorkspace }: {
  trailId?: string; canAct?: boolean; principal?: string; questionWorkspace?: string;
}) {
  const api = useApi();
  const inbox = useAsync(() => api.inbox(), "inbox");
  const last = useRef<{ api: ConsoleApi; items: InboxEntry[] } | undefined>(undefined);
  if (inbox.state.status === "ready") last.current = { api, items: inbox.state.data };
  const detailState = inbox.state.status === "error" && last.current?.api === api
    ? { status: "ready" as const, data: last.current.items, refreshing: false } : inbox.state;
  return (
    <div className="page">
      <PageHeader
        title="Inbox"
        lede="Questions that can unblock Ephyra, checkpoint reviews and spend requests."
        actions={
          <Button size="sm" onClick={inbox.reload}>
            Refresh
          </Button>
        }
      />
      {principal && questionWorkspace && <InvestigationQuestions api={api} principal={principal} workspace={questionWorkspace} trailId={trailId} />}
      <div className="inbox-split" data-detail={trailId ? "true" : "false"}>
        <section className="inbox-list-pane" aria-label="Waiting items">
          <Load state={inbox.state} retry={inbox.reload} skeleton={<Skeleton lines={5} />}>
            {(items) => <InboxList items={items} selected={trailId} />}
          </Load>
        </section>
        <section className="inbox-detail-pane" aria-label="Quest detail">
          {trailId ? (
            <>
              <p className="inbox-back">
                <a href="#/inbox">← All items</a>
              </p>
              <Load state={detailState} retry={inbox.reload} skeleton={<Skeleton block />}>
                {(items) => (
                  <TrailPanel trailId={trailId} items={items} canAct={canAct} principal={principal} onChanged={inbox.reload} />
                )}
              </Load>
            </>
          ) : (
            <Card tone="inset">
              <Empty title="Pick an item" body="Open a quest to see its checkpoints, runs and timeline." />
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
import { useRef } from "react";
import type { ConsoleApi, InboxEntry } from "../api.ts";
