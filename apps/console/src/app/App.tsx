import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ApiProvider } from "./ApiContext.tsx";
import { useAsync } from "./useAsync.ts";
import type { ConsoleApi, SessionInfo } from "../api.ts";
import { Shell, type NavItem } from "../kit.ts";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { Empty, Skeleton } from "../kit.ts";
import { InboxPage } from "../pages/InboxPage.tsx";
import { OverviewPage } from "../pages/OverviewPage.tsx";
import { PersonasPage } from "../pages/PersonasPage.tsx";
const RunPage = lazy(() => import("../pages/RunPage.tsx").then((m) => ({ default: m.RunPage })));
import { RunsPage } from "../pages/RunsPage.tsx";
import { UsagePage } from "../pages/UsagePage.tsx";
const DraftPage = lazy(() => import("../pages/DraftPage.tsx").then((m) => ({ default: m.DraftPage })));
import { WorkspacePage } from "../pages/WorkspacePage.tsx";
import { parseRoute, type PageId, type Route } from "./route.ts";
import "./App.css";
import { VoiceProvider, VoiceLauncher } from "../voice/Voice.tsx";
import type { VoiceContext } from "@ephyra/core";

const LABEL: Record<PageId, string> = {
  overview: "Overview",
  usage: "Usage",
  inbox: "Inbox",
  runs: "Runs",
  workspace: "Workspace",
  personas: "Personas",
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

function Page({ route, approver, principal }: { route: Route; approver: boolean; principal?: string }) {
  switch (route.page) {
    case "overview":
      return <OverviewPage />;
    case "usage":
      return <UsagePage />;
    case "inbox":
      return <InboxPage trailId={route.id} canAct={approver} principal={principal} />;
    case "runs":
      return route.id ? <RunPage runId={route.id} /> : <RunsPage />;
    case "workspace":
      return route.id ? (
        <DraftPage draftId={route.id} canPublish={approver} />
      ) : (
        <WorkspacePage canDraft={approver} />
      );
    case "personas":
      return <PersonasPage />;
    default:
      return (
        <Empty
          title="That page does not exist"
          body={`There is nothing at “${route.path}”.`}
          action={<a href="#/overview">Go to the overview</a>}
        />
      );
  }
}

/** The console: navigation, the current screen, and the API every screen reads. */
export function App({
  api,
  approver = true,
  demo,
  identity,
  onDisconnect,
}: {
  api: ConsoleApi;
  approver?: boolean;
  demo?: boolean;
  identity?: SessionInfo;
  onDisconnect?: () => void;
}) {
  const route = useRoute();
  const sessionKey = useMemo(() => crypto.randomUUID(), [api, identity?.principal]);
  return (
    <ApiProvider api={api}>
      <Frame
        key={sessionKey}
        route={route}
        approver={approver}
        demo={demo}
        api={api}
        identity={identity}
        onDisconnect={onDisconnect}
      />
    </ApiProvider>
  );
}

function Frame({
  route,
  approver,
  demo,
  api,
  identity,
  onDisconnect,
}: {
  identity?: SessionInfo;
  onDisconnect?: () => void;
  route: Route;
  approver: boolean;
  demo?: boolean;
  api: ConsoleApi;
}) {
  const inbox = useAsync(() => api.inbox(), `nav:${route.page}`);
  const waiting =
    inbox.state.status === "ready"
      ? inbox.state.data.filter((i) => i.kind === "checkpoint" || i.kind === "spend").length
      : 0;
  const nav: NavItem[] = (Object.keys(LABEL) as PageId[]).map((id) => ({
    id,
    label: LABEL[id],
    icon: id,
    count: id === "inbox" ? waiting : undefined,
    overflow: id === "workspace" || id === "personas",
  }));
  const current = route.page === "not-found" ? "" : route.page;
  const voiceContext: VoiceContext = route.page === "inbox" && route.id ? { kind: "trail", id: route.id }
    : route.page === "runs" && route.id ? { kind: "run", id: route.id }
    : route.page === "workspace" && route.id ? { kind: "draft", id: route.id }
    : route.page === "usage" ? { kind: "usage" } : { kind: "overview" };
  const voiceLabel = voiceContext.kind === "usage" ? "Usage, last 7 days" : voiceContext.kind === "overview" ? "Application overview"
    : `${voiceContext.kind === "trail" ? "Trail" : voiceContext.kind === "run" ? "Run" : "Document"} ${voiceContext.id.slice(0, 12)}`;
  return (
    <VoiceProvider api={api} context={voiceContext} label={voiceLabel} scopeKey={JSON.stringify(route)} canSpend={approver}>
    <Shell
      nav={nav}
      current={current}
      onNavigate={(id) => {
        location.hash = `#/${id}`;
      }}
      user={{
        name: demo ? "Demo" : (identity?.principal ?? "Connected"),
        detail: demo ? "made-up data" : approver ? "approver" : "read only",
        avatar: (
          <span className="account-mark" aria-hidden="true">
            {demo ? "D" : "U"}
          </span>
        ),
      }}
    >
      {voiceContext.kind !== "draft" && <div className="voice-entry"><VoiceLauncher /></div>}
      <Suspense fallback={<Skeleton block />}>
        <Page
          key={route.page === "not-found" ? route.path : `${route.page}:${route.id ?? ""}`}
          route={route}
          approver={approver}
          principal={identity?.principal}
        />
      </Suspense>
      <footer className="app-foot">
        <ThemeToggle />
        {onDisconnect && (
          <button className="ui-button ui-button--ghost" onClick={onDisconnect}>
            Disconnect this tab
          </button>
        )}
        {demo ? <p className="muted">Demo data · no server connected.</p> : null}
      </footer>
    </Shell>
    </VoiceProvider>
  );
}
