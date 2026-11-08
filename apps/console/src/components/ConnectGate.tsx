import { useState } from "react";
import { Button, Field, PageHeader } from "../kit.ts";
import { JellySpecimen } from "./JellySpecimen.tsx";
import "./ConnectGate.css";

/** Browser sign-in is the normal entry; manual tokens remain available for self-hosted deployments. */
export function ConnectGate({
  onConnect,
  signIn = false,
}: {
  onConnect: (token: string, principal?: string) => void;
  signIn?: boolean;
}) {
  const [token, setToken] = useState("");
  const [principal, setPrincipal] = useState("");
  const connect = () => onConnect(token.trim(), principal.trim() || undefined);
  return (
    <div className="gate">
      <div className="connect-intro">
        <PageHeader
          title={signIn ? "Your Ephyra workspace" : "Connect to Ephyra"}
          lede={
            signIn
              ? "Review trails, follow your agents and their spending, and shape your autonomy policy."
              : "Connect to this deployment with a session or service token."
          }
        />
        <JellySpecimen size={112} />
      </div>
      {signIn && (
        <section className="connect-account" aria-label="Account sign-in">
          <div className="stack">
            <p>Use your Not Organic account to open this workspace.</p>
            <div>
              <a className="ui-button ui-button--primary" href="/auth/login">
                Sign in with Not Organic
              </a>
            </div>
            <p className="muted">Your account’s permissions determine which changes you can approve.</p>
          </div>
        </section>
      )}
      <details className="connect-token" open={signIn ? undefined : true}>
        <summary>Connect with a token</summary>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) connect();
          }}
        >
          <p className="muted">The token stays in this tab and is sent only to this server.</p>
          <Field label="Session token" hint="Use the session token from ephyra login for this deployment.">
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
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
      </details>
      <p className="muted">
        Want to look around first? <a href="?demo=1">Open the sample workspace</a>, which uses made-up data and never
        contacts a server.
      </p>
    </div>
  );
}
