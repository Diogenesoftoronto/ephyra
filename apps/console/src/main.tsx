import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleClient } from "./api.ts";
import { App } from "./app/App.tsx";
import { useAsync } from "./app/useAsync.ts";
import { ConnectGate } from "./components/ConnectGate.tsx";
import { Load } from "./components/Load.tsx";
import { FakeApi } from "./fake/api.ts";
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
  if (fake) return <App api={fake} demo />;
  if (!credentials) return <ConnectGate onConnect={(token, principal) => save({ token, principal })} />;
  return <Connected credentials={credentials} disconnect={() => save(null)} />;
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
