import { SoundToggle } from "../components/SoundToggle.tsx";
import { useEffect, useMemo, useState } from "react";
import type { AccountSettings, WorkspaceAccess } from "@ephyra/core";
import { ConsoleClient, type SessionInfo } from "../api.ts";
import type { AccountApi } from "../account-api.ts";
import { TeamClient } from "../team-api.ts";
import { SetupClient } from "../setup-api.ts";
import { InvitationAccept } from "../components/InvitationAccept.tsx";
import { MaterialScene } from "../components/MaterialScene.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { Load } from "../components/Load.tsx";
import { Button, Empty } from "../kit.ts";
import { App } from "./App.tsx";
import { useAsync } from "./useAsync.ts";
import { readWorkspaceChoice, rememberWorkspace } from "../lib/workspace-selection.ts";

export type InvitationFlow = { token: string | null; clear: () => void };
type Props = {
  identity: SessionInfo; token: string; settings: AccountSettings; accountApi: AccountApi;
  onChange: (settings: AccountSettings) => void; onDisconnect: () => void;
  disconnectLabel?: string; invitation: InvitationFlow;
};

export function AccountWorkspace(props: Props) {
  const { identity, token, settings, invitation } = props;
  const team = useMemo(() => new TeamClient(location.origin, token, fetch, identity.principal), [token, identity.principal]);
  const workspaces = useAsync(() => team.workspaces(), `workspaces:${identity.principal}:${settings.workspaceId}`);
  const [selected, setSelected] = useState(() => {
    try { return readWorkspaceChoice(sessionStorage, identity.principal, settings.workspaceId); }
    catch { return settings.workspaceId; }
  });
  // A removed membership unmounts its data. Errors fail closed rather than retaining old access indefinitely.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") workspaces.reload(); };
    const timer = setInterval(refresh, 15_000);
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [workspaces.reload]);
  const teamChanged = () => {
    workspaces.reload();
    // Team changes share the account's version. Re-read it before the next settings write.
    void props.accountApi.settings().then(props.onChange).catch(() => undefined);
  };
  const choose = (id: string) => {
    setSelected(id);
    try { rememberWorkspace(sessionStorage, identity.principal, settings.workspaceId, id); } catch { /* Storage blocked. */ }
    location.hash = "#/overview";
  };
  if (invitation.token) return (
    <main className="entry-page">
      <div className="entry-toolbar"><span>ephyra</span><span className="entry-preferences"><SoundToggle /><ThemeToggle /></span></div>
      <div className="gate invitation-gate">
        <MaterialScene title="Follow the work together."
          description="A shared view of investigations, agent runs, and the evidence behind each change." />
        <div className="connect-form-surface">
          <p className="account-hint">Signed in as {identity.alias ?? identity.principal}</p>
          <InvitationAccept key={invitation.token} api={team} token={invitation.token}
            onCancel={invitation.clear} onAccepted={(access) => {
              const current = workspaces.state.status === "ready" ? workspaces.state.data : [];
              workspaces.set([...current.filter((item) => item.workspaceId !== access.workspaceId), access]);
              invitation.clear();
              choose(access.workspaceId);
              workspaces.reload();
            }} />
          <Button variant="ghost" onClick={() => { invitation.clear(); props.onDisconnect(); }}>
            {props.disconnectLabel ?? "Use another account"}
          </Button>
        </div>
      </div>
    </main>
  );
  return <Load state={workspaces.state} retry={workspaces.reload}>{(all) => {
    const access = all.find((item) => item.workspaceId === selected);
    if (!access) return <div className="workspace-unavailable"><Empty title="This workspace is no longer available"
      body="Your access or the repository may have changed. Choose your own workspace to continue."
      action={<Button onClick={() => choose(settings.workspaceId)}>Open my workspace</Button>} /></div>;
    return <WorkspaceSession key={access.workspaceId} {...props} access={access} team={team} onTeamChanged={teamChanged}
      switcher={<label className="workspace-picker"><span>Workspace</span>
        <select aria-label="Workspace" value={selected} onChange={(event) => choose(event.target.value)}>
          {all.map((item) => <option key={item.workspaceId} value={item.workspaceId}>
            {item.name} · {item.role === "owner" ? "Your workspace" : item.role === "approver" ? "Approver" : "Viewer"}
          </option>)}
        </select>
      </label>} />;
  }}</Load>;
}

function WorkspaceSession({ identity, token, settings, accountApi, onChange, onDisconnect, disconnectLabel,
  access, team, onTeamChanged, switcher }: Props & {
    access: WorkspaceAccess; team: TeamClient; onTeamChanged: () => void; switcher: React.ReactNode;
  }) {
  const api = useMemo(() => new ConsoleClient(location.origin, token, fetch, identity.principal, access.workspaceId),
    [token, identity.principal, access.workspaceId]);
  const automation = useMemo(() => new SetupClient(location.origin, token, access.workspaceId, identity.principal),
    [token, access.workspaceId, identity.principal]);
  const session = useAsync(() => api.identity(), `workspace:${identity.principal}:${access.workspaceId}:${access.role}`);
  useEffect(() => {
    if (access.role === "owner" && ["new", "in_progress"].includes(settings.onboarding.status)
      && ["", "#", "#/", "#/overview"].includes(location.hash)) location.hash = "#/onboarding";
  }, [identity.principal, access.workspaceId]);
  return <Load state={session.state} retry={session.reload}>{(current) => (
    <App api={api} identity={{ ...current, alias: identity.alias }} approver={current.approver}
      account={access.role === "owner" ? { api: accountApi, settings, onChange, automation } : undefined}
      team={access.role === "owner" ? { api: team, onChanged: onTeamChanged } : undefined}
      workspace={{ name: access.name, role: access.role, switcher }}
      onDisconnect={onDisconnect} disconnectLabel={disconnectLabel} />
  )}</Load>;
}
