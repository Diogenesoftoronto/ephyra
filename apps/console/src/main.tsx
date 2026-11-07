import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleClient, type ConsoleApi } from "./api.ts";
import { App } from "./app/App.tsx";
import { ConnectGate } from "./components/ConnectGate.tsx";
import { FakeApi } from "./fake/api.ts";
import "./theme.css";
import "./layout.css";

const TOKEN_KEY = "ephyra.token";
const readToken = (): string | null => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };

// Restore a saved theme before the first paint.
try {
  const theme = localStorage.getItem("ephyra.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* storage may be blocked */ }

function Root() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [token, setToken] = useState<string | null>(readToken);
  const fake = useMemo(() => (demo ? new FakeApi({ now: Date.now() }) : null), [demo]);
  if (fake) return <App api={fake} demo />;
  if (!token) {
    return <ConnectGate onConnect={(t) => { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* keep in memory */ } setToken(t); }} />;
  }
  const api: ConsoleApi = new ConsoleClient(location.origin, token);
  return <App api={api} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
