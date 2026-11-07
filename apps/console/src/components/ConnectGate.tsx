import { useState } from "react";
import { Button, Card, Field, PageHeader } from "../kit.ts";

/**
 * Shown when the console has no session token. The token is kept for this browser tab only (sessionStorage) and sent to
 * this server only. How a person normally gets one (Not Organic sign-in) is Unverified: see the README.
 */
export function ConnectGate({ onConnect }: { onConnect: (token: string, principal?: string) => void }) {
  const [token, setToken] = useState("");
  const [principal, setPrincipal] = useState("");
  const connect = () => onConnect(token.trim(), principal.trim() || undefined);
  return (
    <div className="gate">
      <PageHeader
        title="Connect to Ephyra"
        lede="Paste a session token for this deployment. It stays in this tab and is sent only to this server."
      />
      <Card>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) connect();
          }}
        >
          <Field label="Session token" hint="Use the session token from ephyra login for this deployment.">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <details>
            <summary>Local development with a service token</summary>
            <Field
              label="Service principal"
              hint="Required only for a service token. Sign-in deployments restrict it to reading."
            >
              <input value={principal} onChange={(e) => setPrincipal(e.target.value)} autoComplete="off" />
            </Field>
          </details>
          <div>
            <Button variant="primary" disabled={!token.trim()} onClick={() => connect()}>
              Connect
            </Button>
          </div>
        </form>
      </Card>
      <p className="muted">
        Want to look around first? <a href="?demo=1">Open the demo</a>, which uses made-up data and never
        contacts a server.
      </p>
    </div>
  );
}
