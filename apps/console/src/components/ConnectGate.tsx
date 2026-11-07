import { useState } from "react";
import { Button, Card, Field, PageHeader } from "../kit.ts";

/**
 * Shown when the console has no session token. The token is kept for this browser tab only (sessionStorage) and sent to
 * this server only. How a person normally gets one (Not Organic sign-in) is Unverified: see the README.
 */
export function ConnectGate({ onConnect }: { onConnect: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <div className="gate">
      <PageHeader title="Connect to Ephyra" lede="Paste a session token for this deployment. It stays in this tab and is sent only to this server." />
      <Card>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (token.trim()) onConnect(token.trim()); }}>
          <Field label="Session token" hint="Run `ephyra login` in your terminal, or ask an approver for a service token.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <div><Button variant="primary" disabled={!token.trim()} onClick={() => onConnect(token.trim())}>Connect</Button></div>
        </form>
      </Card>
      <p className="muted">Want to look around first? <a href="?demo=1">Open the demo</a>, which uses made-up data and never contacts a server.</p>
    </div>
  );
}
