import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, Empty, PageHeader, Skeleton } from "../kit.ts";
import { InboxList } from "../components/InboxList.tsx";
import { Load } from "../components/Load.tsx";
import { TrailPanel } from "./TrailPanel.tsx";
import "./InboxPage.css";

/** The terminal inbox in a browser: what waits on a person, and the trail you have open beside it. */
export function InboxPage({ trailId, canAct = true }: { trailId?: string; canAct?: boolean }) {
  const api = useApi();
  const inbox = useAsync(() => api.inbox(), "inbox");
  return (
    <div className="page">
      <PageHeader title="Inbox" lede="Checkpoints, spend requests and parked trails that need a person."
        actions={<Button size="sm" onClick={inbox.reload}>Refresh</Button>} />
      <div className="inbox-split" data-detail={trailId ? "true" : "false"}>
        <section className="inbox-list-pane" aria-label="Waiting items">
          <Load state={inbox.state} retry={inbox.reload} skeleton={<Skeleton lines={5} />}>{(items) => <InboxList items={items} selected={trailId} />}</Load>
        </section>
        <section className="inbox-detail-pane" aria-label="Trail detail">
          {trailId ? (
            <>
              <p className="inbox-back"><a href="#/inbox">← All items</a></p>
              <Load state={inbox.state} retry={inbox.reload} skeleton={<Skeleton block />}>
                {(items) => <TrailPanel trailId={trailId} items={items} canAct={canAct} onChanged={inbox.reload} />}
              </Load>
            </>
          ) : <Card tone="inset"><Empty title="Pick an item" body="Open a trail to see its checkpoints, runs and timeline." /></Card>}
        </section>
      </div>
    </div>
  );
}
