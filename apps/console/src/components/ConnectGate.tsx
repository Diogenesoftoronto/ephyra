import { useState } from "react";
import { Button, Field, PageHeader } from "../kit.ts";
import { MaterialScene } from "./MaterialScene.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import "./ConnectGate.css";

/** Browser sign-in is the normal entry; manual tokens remain available for self-hosted deployments. */
export function ConnectGate({
  onConnect,
  signIn = false,
  invitation = false,
}: {
  onConnect: (token: string, principal?: string) => void;
  signIn?: boolean;
  invitation?: boolean;
}) {
  const [token, setToken] = useState("");
  const [principal, setPrincipal] = useState("");
  const connect = () => onConnect(token.trim(), principal.trim() || undefined);
  return (
    <main className="entry-page">
      <div className="entry-toolbar"><a href="/">ephyra</a><ThemeToggle /></div>
      <div className="gate">
      <MaterialScene title="From signal to proof."
        description="Follow the investigation. See the evidence. Decide where Ephyra can act.">
        <ol className="connect-journey" aria-label="Inside your workspace">
          <li><span>01</span> Connect your application</li>
          <li><span>02</span> Follow the work as it happens</li>
          <li><span>03</span> Bring your team into the loop</li>
        </ol>
      </MaterialScene>
      <div className="connect-form-surface">
      <div className="connect-intro">
        <PageHeader
          title={invitation ? "Join your team’s workspace" : signIn ? "Your Ephyra workspace" : "Connect to Ephyra"}
          lede={
            invitation ? "Sign in to review and accept your invitation. Your team’s work will be waiting here."
              : signIn
              ? "A place to see what’s happening, understand what changed, and choose what comes next."
              : "Connect to this deployment with a session or service token."
          }
        />
      </div>
      {signIn && (
        <section className="connect-account" aria-label="Account sign-in">
          <div className="stack">
            <p>Sign in or create an account with Not Organic.</p>
            <div>
              <a className="ui-button ui-button--primary" href="/auth/login">
                Sign in with Not Organic
              </a>
            </div>
            <p className="muted">{invitation ? "You’ll see your invitation’s access level before joining."
              : "New here? We’ll help you connect your first repository after sign-in."}</p>
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
      <p className="muted connect-demo">
        <a href="?demo=1">Explore a sample workspace <span aria-hidden="true">↗</span></a>
        <span>Made-up data. No account needed.</span>
      </p>
      </div>
      </div>
    </main>
  );
}
