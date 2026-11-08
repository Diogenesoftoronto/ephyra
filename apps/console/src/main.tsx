import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleClient, type SessionInfo } from "./api.ts";
import { AccountClient, type AccountApi } from "./account-api.ts";
import type { AccountSettings } from "@ephyra/core";
import { App } from "./app/App.tsx";
import { useAsync } from "./app/useAsync.ts";
import { ConnectGate } from "./components/ConnectGate.tsx";
import { ErrorState, Load } from "./components/Load.tsx";
import { FakeApi } from "./fake/api.ts";
import { ME } from "./fake/fixtures.ts";
import { FakeAccountApi } from "./fake/account.ts";
import "./theme.css";
import "./layout.css";

type Credentials = { token: string; principal?: string };
const TOKEN_KEY = "ephyra.connection";
const readCredentials = (): Credentials | null => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null");
    return stored && typeof stored.token === "string" && (!stored.principal || typeof stored.principal === "string")
      ? stored
      : null;
  } catch {
    return null;
  }
};
try {
  const theme = localStorage.getItem("ephyra.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  /* storage may be blocked */
}

function Connected({ credentials, disconnect }: { credentials: Credentials; disconnect: () => void }) {
  const api = useMemo(
    () => new ConsoleClient(location.origin, credentials.token, fetch, credentials.principal),
    [credentials],
  );
  const session = useAsync(() => api.identity(), "identity");
  return (
    <>
      <Load state={session.state} retry={session.reload}>
        {(identity) =>
          identity.kind === "human" ? (
            <AccountConnection
              key={identity.principal}
              identity={identity}
              token={credentials.token}
              onDisconnect={disconnect}
            />
          ) : (
            <App api={api} identity={identity} approver={identity.approver} onDisconnect={disconnect} />
          )
        }
      </Load>
      {session.state.status !== "ready" && (
        <div className="connection-reset">
          <button className="ui-button ui-button--ghost" onClick={disconnect}>
            Use another connection
          </button>
        </div>
      )}
    </>
  );
}

function Root() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [credentials, setCredentials] = useState<Credentials | null>(readCredentials);
  const fake = useMemo(() => (demo ? new FakeApi({ now: Date.now() }) : null), [demo]);
  const save = (value: Credentials | null) => {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* memory only */
    }
    setCredentials(value);
  };
  if (fake) return <Demo api={fake} />;
  if (!credentials) return <BrowserConnection onConnect={(token, principal) => save({ token, principal })} />;
  return <Connected credentials={credentials} disconnect={() => save(null)} />;
}

function BrowserConnection({ onConnect }: { onConnect: (token: string, principal?: string) => void }) {
  const api = useMemo(() => new ConsoleClient(location.origin), []);
  const session = useAsync(() => api.browserSession(), "browser-session");
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  // A different tab can replace an HttpOnly cookie. Re-read identity when this tab returns;
  // every workspace/account request is also bound to its original owner on the server.
  useEffect(() => {
    let live = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const value = await api.browserSession();
        if (live) session.set(value);
      } catch {
        if (live) session.reload();
      } finally {
        reading = false;
      }
    };
    addEventListener("focus", refresh);
    addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      removeEventListener("focus", refresh);
      removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, session.set, session.reload]);
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError(null);
    try {
      await api.signOut();
      session.set({ signIn: true, identity: null });
    } catch (error) {
      setLogoutError(error);
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <>
      {logoutError !== null && (
        <div className="connection-reset">
          <ErrorState error={logoutError} onRetry={signOut} />
        </div>
      )}
      <Load state={session.state} retry={session.reload}>
        {({ signIn, identity }) =>
          identity ? (
            <AccountConnection
              key={identity.principal}
              identity={identity}
              onDisconnect={signOut}
              disconnectLabel={signingOut ? "Signing out…" : "Sign out"}
            />
          ) : (
            <ConnectGate signIn={signIn} onConnect={onConnect} />
          )
        }
      </Load>
    </>
  );
}

function AccountConnection({
  identity,
  token = "",
  onDisconnect,
  disconnectLabel,
}: {
  identity: SessionInfo;
  token?: string;
  onDisconnect: () => void;
  disconnectLabel?: string;
}) {
  const accountApi = useMemo(
    () => new AccountClient(location.origin, token, fetch, identity.principal),
    [token, identity.principal],
  );
  const account = useAsync(() => accountApi.settings(), `account:${identity.principal}`);
  return (
    <Load state={account.state} retry={account.reload}>
      {(settings) => (
        <PersonalApp
          identity={identity}
          token={token}
          settings={settings}
          accountApi={accountApi}
          onChange={account.set}
          onDisconnect={onDisconnect}
          disconnectLabel={disconnectLabel}
        />
      )}
    </Load>
  );
}

function PersonalApp({
  identity,
  token,
  settings,
  accountApi,
  onChange,
  onDisconnect,
  disconnectLabel,
}: {
  identity: SessionInfo;
  token: string;
  settings: AccountSettings;
  accountApi: AccountApi;
  onChange: (settings: AccountSettings) => void;
  onDisconnect: () => void;
  disconnectLabel?: string;
}) {
  const api = useMemo(
    () => new ConsoleClient(location.origin, token, fetch, undefined, settings.workspaceId),
    [token, settings.workspaceId],
  );
  const workspace = useAsync(() => api.identity(), `workspace:${identity.principal}:${settings.workspaceId}`);
  useEffect(() => {
    if (
      ["new", "in_progress"].includes(settings.onboarding.status) &&
      ["", "#", "#/", "#/overview"].includes(location.hash)
    )
      location.hash = "#/onboarding";
  }, [identity.principal]);
  return (
    <Load state={workspace.state} retry={workspace.reload}>
      {(owner) => (
        <App
          api={api}
          identity={{ ...owner, alias: identity.alias }}
          approver={owner.approver}
          account={{ api: accountApi, settings, onChange }}
          onDisconnect={onDisconnect}
          disconnectLabel={disconnectLabel}
        />
      )}
    </Load>
  );
}

function Demo({ api }: { api: FakeApi }) {
  const accountApi = useMemo(() => new FakeAccountApi(), []);
  const account = useAsync(() => accountApi.settings(), "demo-account");
  return (
    <Load state={account.state} retry={account.reload}>
      {(settings) => (
        <App
          api={api}
          demo
          identity={{ principal: ME, kind: "human", approver: true }}
          account={{ api: accountApi, settings, onChange: account.set }}
        />
      )}
    </Load>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
