import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleClient } from "./api.ts";
import { App } from "./app/App.tsx";
import { useAsync } from "./app/useAsync.ts";
import { ConnectGate } from "./components/ConnectGate.tsx";
import { ErrorState, Load } from "./components/Load.tsx";
import { FakeApi } from "./fake/api.ts";
import { ME } from "./fake/fixtures.ts";
import "./theme.css";
import "./layout.css";

type Credentials = { token: string; principal?: string };
const TOKEN_KEY = "ephyra.connection";
const readCredentials = (): Credentials | null => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null");
    return stored &&
      typeof stored.token === "string" &&
      (!stored.principal || typeof stored.principal === "string")
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
        {(identity) => (
          <App api={api} identity={identity} approver={identity.approver} onDisconnect={disconnect} />
        )}
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
  if (fake) return <App api={fake} demo identity={{ principal: ME, kind: "human", approver: true }} />;
  if (!credentials) return <BrowserConnection onConnect={(token, principal) => save({ token, principal })} />;
  return <Connected credentials={credentials} disconnect={() => save(null)} />;
}

function BrowserConnection({ onConnect }: { onConnect: (token: string, principal?: string) => void }) {
  const api = useMemo(() => new ConsoleClient(location.origin), []);
  const session = useAsync(() => api.browserSession(), "browser-session");
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError(null);
    try {
      await api.signOut();
      session.set({ signIn: true, identity: null });
    } catch (error) { setLogoutError(error); }
    finally { setSigningOut(false); }
  };
  return <>
    {logoutError !== null && <div className="connection-reset"><ErrorState error={logoutError} onRetry={signOut} /></div>}
    <Load state={session.state} retry={session.reload}>
      {({ signIn, identity }) => identity
        ? <App api={api} identity={identity} approver={identity.approver} onDisconnect={signOut}
            disconnectLabel={signingOut ? "Signing out…" : "Sign out"} />
        : <ConnectGate signIn={signIn} onConnect={onConnect} />}
    </Load>
  </>;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
