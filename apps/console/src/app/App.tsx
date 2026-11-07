import { useEffect, useState } from "react";
import { ApiProvider } from "./ApiContext.tsx";
import { useAsync } from "./useAsync.ts";
import type { ConsoleApi } from "../api.ts";
import { Badge, Shell, type NavItem } from "../kit.ts";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { Empty } from "../kit.ts";
import { InboxPage } from "../pages/InboxPage.tsx";
import { OverviewPage } from "../pages/OverviewPage.tsx";
import { PersonasPage } from "../pages/PersonasPage.tsx";
import { RunPage } from "../pages/RunPage.tsx";
import { RunsPage } from "../pages/RunsPage.tsx";
import { UsagePage } from "../pages/UsagePage.tsx";
import { DraftPage } from "../pages/DraftPage.tsx";
import { WorkspacePage } from "../pages/WorkspacePage.tsx";
import { parseRoute, type PageId, type Route } from "./route.ts";
import "./App.css";

const LABEL: Record<PageId, string> = {
  overview: "Overview", usage: "Usage", inbox: "Inbox", runs: "Runs", workspace: "Workspace", personas: "Personas",
};

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

function Page({ route, approver }: { route: Route; approver: boolean }) {
  switch (route.page) {
    case "overview": return <OverviewPage />;
    case "usage": return <UsagePage />;
    case "inbox": return <InboxPage trailId={route.id} canAct={approver} />;
    case "runs": return route.id ? <RunPage runId={route.id} /> : <RunsPage />;
    case "workspace": return route.id ? <DraftPage draftId={route.id} canPublish={approver} /> : <WorkspacePage canDraft={approver} />;
    case "personas": return <PersonasPage />;
    default: return <Empty title="That page does not exist" body={`There is nothing at “${route.path}”.`} action={<a href="#/overview">Go to the overview</a>} />;
  }
}

/** The console: navigation, the current screen, and the API every screen reads. */
export function App({ api, approver = true, demo }: { api: ConsoleApi; approver?: boolean; demo?: boolean }) {
  const route = useRoute();
  return (
    <ApiProvider api={api}>
      <Frame route={route} approver={approver} demo={demo} api={api} />
    </ApiProvider>
  );
}

function Frame({ route, approver, demo, api }: { route: Route; approver: boolean; demo?: boolean; api: ConsoleApi }) {
  const inbox = useAsync(() => api.inbox(), `nav:${route.page}`);
  const waiting = inbox.state.status === "ready" ? inbox.state.data.filter((i) => i.kind === "checkpoint" || i.kind === "spend").length : 0;
  const nav: NavItem[] = (Object.keys(LABEL) as PageId[]).map((id) => ({ id, label: LABEL[id], count: id === "inbox" ? waiting : undefined }));
  const current = route.page === "not-found" ? "" : route.page;
  return (
    <Shell nav={nav} current={current} onNavigate={(id) => { location.hash = `#/${id}`; }}
      user={<span className="app-user">{demo && <Badge tone="info">demo data</Badge>}<ThemeToggle /></span>}>
      <Page route={route} approver={approver} />
    </Shell>
  );
}
