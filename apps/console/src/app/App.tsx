import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
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
import type { AccountSettings } from "@ephyra/core";
import type { AccountApi } from "../account-api.ts";
import type { SetupApi } from "../setup-api.ts";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { OnboardingPage } from "../pages/OnboardingPage.tsx";
import { CommandMenu } from "../components/CommandMenu.tsx";
import type { TeamApi } from "../team-api.ts";
import { TeamPage } from "../pages/TeamPage.tsx";

export type TeamContext = { api: TeamApi; onChanged?: () => void };
export type WorkspaceContext = { name: string; role: "owner" | "viewer" | "approver"; switcher: ReactNode };

export type AccountContext = {
  automation?: SetupApi;
  api: AccountApi;
  settings: AccountSettings;
  onChange: (settings: AccountSettings) => void;
};

const LABEL: Record<PageId, string> = {
  overview: "Overview",
  usage: "Usage",
  inbox: "Inbox",
  runs: "Runs",
  workspace: "Workspace",
  personas: "Personas",
  team: "Team",
  settings: "Settings",
  onboarding: "Setup",
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

function Page({
  route,
  approver,
  principal,
  account,
  onDisconnect,
  disconnectLabel,
  alias,
  team,
  workspace,
}: {
  alias?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  route: Route;
  approver: boolean;
  principal?: string;
  account?: AccountContext;
  team?: TeamContext;
  workspace?: WorkspaceContext;
}) {
  switch (route.page) {
    case "overview":
      return <OverviewPage />;
    case "usage":
      return <UsagePage />;
    case "inbox":
      return <InboxPage trailId={route.id} canAct={approver} principal={principal} questionWorkspace={account?.settings.workspaceId} />;
    case "runs":
      return route.id ? <RunPage runId={route.id} /> : <RunsPage />;
    case "workspace":
      return route.id ? <DraftPage draftId={route.id} canPublish={approver} /> : <WorkspacePage canDraft={approver} />;
    case "personas":
      return <PersonasPage />;
    case "team":
      return team ? <TeamPage {...team} /> : <Empty title="Team access is managed by the owner"
        body="Switch to your own workspace to invite viewers and approvers." />;
    case "settings":
    case "onboarding":
      if (!account)
        return (
          <Empty
            title={workspace ? "Settings belong to the workspace owner" : "Personal account settings"}
            body={workspace ? "Switch to your own workspace to manage its repository, model access, and account."
              : "Sign in with Not Organic to connect your repository and choose model access. Service tokens use deployment configuration."}
          />
        );
      return route.page === "settings" ? (
        <SettingsPage
          {...account}
          onDisconnect={onDisconnect}
          disconnectLabel={disconnectLabel}
          alias={alias}
          onResumeSetup={() => {
            location.hash = "#/onboarding";
          }}
        />
      ) : (
        <OnboardingPage
          {...account}
          onDone={() => {
            location.hash = "#/overview";
          }}
        />
      );
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
  disconnectLabel = "Disconnect this tab",
  account,
  team,
  workspace,
}: {
  api: ConsoleApi;
  approver?: boolean;
  demo?: boolean;
  identity?: SessionInfo;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  account?: AccountContext;
  team?: TeamContext;
  workspace?: WorkspaceContext;
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
        disconnectLabel={disconnectLabel}
        account={account}
        team={team}
        workspace={workspace}
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
  disconnectLabel,
  account,
  team,
  workspace,
}: {
  identity?: SessionInfo;
  onDisconnect?: () => void;
  disconnectLabel: string;
  route: Route;
  approver: boolean;
  demo?: boolean;
  api: ConsoleApi;
  account?: AccountContext;
  team?: TeamContext;
  workspace?: WorkspaceContext;
}) {
  const inbox = useAsync(() => api.inbox(), `nav:${route.page}`);
  const waiting =
    inbox.state.status === "ready"
      ? inbox.state.data.filter((i) => i.kind === "checkpoint" || i.kind === "spend").length
      : 0;
  const nav: NavItem[] = (Object.keys(LABEL) as PageId[])
    .filter((id) => id !== "onboarding" && (id !== "team" || team))
    .map((id) => ({
      id,
      label: LABEL[id],
      icon: id,
      count: id === "inbox" ? waiting : undefined,
      overflow: id === "workspace" || id === "personas" || id === "team" || id === "settings",
    }));
  const current = route.page === "not-found" ? "" : route.page;
  const voiceContext: VoiceContext =
    route.page === "inbox" && route.id
      ? { kind: "trail", id: route.id }
      : route.page === "runs" && route.id
        ? { kind: "run", id: route.id }
        : route.page === "workspace" && route.id
          ? { kind: "draft", id: route.id }
          : route.page === "usage"
            ? { kind: "usage" }
            : { kind: "overview" };
  const voiceLabel =
    voiceContext.kind === "usage"
      ? "Usage, last 7 days"
      : voiceContext.kind === "overview"
        ? "Application overview"
        : `${voiceContext.kind === "trail" ? "Trail" : voiceContext.kind === "run" ? "Run" : "Document"} ${voiceContext.id.slice(0, 12)}`;
  return (
    <VoiceProvider
      api={api}
      context={voiceContext}
      label={voiceLabel}
      scopeKey={JSON.stringify(route)}
      canSpend={approver}
    >
      <Shell
        nav={nav}
        current={current}
        onNavigate={(id) => {
          location.hash = `#/${id}`;
        }}
        user={{
          name: demo ? "Demo" : (identity?.alias ?? "Your account"),
          detail: demo ? "made-up data" : workspace?.role ?? (account ? "personal workspace" : approver ? "approver" : "read only"),
          avatar: (
            <span className="account-mark" aria-hidden="true">
              {demo ? "D" : "U"}
            </span>
          ),
        }}
      >
        <div className="workspace-bar">
          {workspace ? workspace.switcher : <a href="#/settings" className="workspace-bar__repo" title="Repository and account settings">
            <strong>
              {account?.settings.repository?.url
                .split("/")
                .filter(Boolean)
                .at(-1)
                ?.replace(/\.git$/, "") ?? "Your workspace"}
            </strong>
            <small>{account?.settings.repository?.branch ?? (account ? "Connect a repository" : "Deployment")}</small>
          </a>}
          <div className="workspace-bar__actions">
            <ThemeToggle />
            <CommandMenu />
          </div>
        </div>
        {workspace && workspace.role !== "owner" && (
          <aside className="workspace-access-note">
            <span>Shared workspace · <strong>{workspace.role === "viewer" ? "Viewer" : "Approver"}</strong></span>
            <span>{workspace.role === "viewer" ? "You can follow work and read the evidence."
              : "You can review checkpoints, spending requests, and document changes."}</span>
          </aside>
        )}
        {account &&
          account.settings.onboarding.status !== "complete" &&
          route.page !== "onboarding" &&
          route.page !== "settings" && (
            <aside className="workspace-setup-note">
              <span>Ephyra can prepare your repository and autonomy documents.</span>
              <a href="#/onboarding">View automatic setup →</a>
            </aside>
          )}
        {voiceContext.kind !== "draft" && route.page !== "settings" && route.page !== "onboarding" && route.page !== "team" && (
          <div className="voice-entry">
            <VoiceLauncher />
          </div>
        )}
        <Suspense fallback={<Skeleton block />}>
          <Page
            key={route.page === "not-found" ? route.path : `${route.page}:${route.id ?? ""}`}
            route={route}
            approver={approver}
            principal={identity?.principal}
            account={account}
            team={team}
            workspace={workspace}
            alias={identity?.alias}
            onDisconnect={onDisconnect}
            disconnectLabel={disconnectLabel}
          />
        </Suspense>
        <footer className="app-foot">
          {onDisconnect && !account && (
            <button className="ui-button ui-button--ghost" onClick={onDisconnect}>
              {disconnectLabel}
            </button>
          )}
          {demo ? <p className="muted">Demo data · no server connected.</p> : null}
        </footer>
      </Shell>
    </VoiceProvider>
  );
}
