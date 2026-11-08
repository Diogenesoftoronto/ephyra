import { useEffect, useRef, useState } from "react";
import { PeopleUpdate, TelemetryUpdate, type AccountSettings, type InvestigationContact } from "@ephyra/core";
import { Button, Field, Tag } from "../kit.ts";
import { AccountSaveFeedback, type AccountPageProps } from "./AccountForms.tsx";
import { useAccountWrite } from "./useAccountWrite.ts";
import "./ConnectionPanels.css";

export const defaultOwner = (did: string): InvestigationContact => ({
  id: "workspace-owner", alias: "Workspace owner", roles: ["maintainer", "operator"], areas: [], did,
});

export function AutomationStatus({ settings }: { settings: AccountSettings }) {
  const automation = settings.automation;
  const provider = automation?.provider === "railway" ? "Railway" : automation?.provider === "custom" ? "Custom runner" : "Hosted execution";
  return <section className="connection-status" aria-label="Execution availability">
    <strong>{provider}</strong>
    <Tag>{automation ? automation.configured ? "Configured" : "Not configured" : "Not reported"}</Tag>
    <p className="account-hint">{automation?.detail ?? "This connection has not reported its execution setup yet."}</p>
  </section>;
}

/** Keyed forms and guarded saves keep pending credentials and late replies inside their original account/workspace. */
export function ConnectionPanels(props: AccountPageProps) {
  const scope = `${props.settings.did}:${props.settings.workspaceId}`;
  const current = useRef(scope);
  current.current = scope;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const onChange: AccountPageProps["onChange"] = (next) => {
    if (live.current && current.current === scope && next.did === props.settings.did && next.workspaceId === props.settings.workspaceId) {
      props.onChange(next);
    }
  };
  const telemetry = props.settings.telemetry?.workspaceId === props.settings.workspaceId ? props.settings.telemetry : undefined;
  return <div className="connection-panels" key={scope}>
    <details className="account-advanced">
      <summary>PostHog signals <Tag>{telemetry?.enabled ? telemetry.status === "verified" ? "Connected" : "Enabled" : "Optional"}</Tag></summary>
      <div className="account-advanced-fields"><TelemetryForm {...props} onChange={onChange} /></div>
    </details>
    <details className="account-advanced">
      <summary>Contact routing <Tag>Optional</Tag></summary>
      <div className="account-advanced-fields"><PeopleForm {...props} onChange={onChange} /></div>
    </details>
  </div>;
}

function TelemetryForm({ api, settings, onChange }: AccountPageProps) {
  const saved = settings.telemetry?.workspaceId === settings.workspaceId ? settings.telemetry : undefined;
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [origin, setOrigin] = useState(saved?.origin ?? "");
  const [project, setProject] = useState(saved?.projectId ?? "");
  const [recordings, setRecordings] = useState(saved?.includeRecordings ?? false);
  const [deployment, setDeployment] = useState(saved?.deploymentUrl ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string>();
  const write = useAccountWrite(api, onChange);
  useEffect(() => {
    setEnabled(saved?.enabled ?? false); setOrigin(saved?.origin ?? ""); setProject(saved?.projectId ?? "");
    setRecordings(saved?.includeRecordings ?? false); setKey(""); setClearKey(false); setError(undefined);
    setDeployment(saved?.deploymentUrl ?? "");
  }, [settings]);
  const retained = saved?.keyConfigured && origin.trim().replace(/\/$/, "") === saved.origin.replace(/\/$/, "") && project.trim() === saved.projectId;
  return <form className="account-form" aria-label="PostHog connection" onSubmit={async (event) => {
    event.preventDefault();
    const input = TelemetryUpdate.safeParse({ expectedVersion: settings.version, workspaceId: settings.workspaceId, enabled,
      origin: enabled ? origin.trim() : "", projectId: enabled ? project.trim() : "", includeRecordings: recordings,
      ...(enabled ? { deploymentUrl: deployment.trim() } : {}),
      ...(key.trim() ? { apiKey: key.trim() } : {}), ...(clearKey ? { clearKey: true } : {}),
    });
    if (!input.success) { setError("Check the PostHog origin, project ID and key."); return; }
    setError(undefined);
    const result = await write.save(input.data, (value, operation) => api.saveTelemetry(value, operation), "PostHog preferences saved.");
    if (result) setKey("");
  }}>
    <p className="account-hint">Connect observed errors so Ephyra can investigate production signals. This is optional.</p>
    <label className="account-checkbox"><input type="checkbox" checked={enabled} disabled={write.locked}
      onChange={(event) => { setEnabled(event.target.checked); setKey(""); setClearKey(false); }} />Use PostHog for this workspace</label>
    <fieldset className="account-fields" disabled={!enabled || write.locked}>
      <Field label="PostHog origin" hint="The HTTPS origin of your PostHog instance, without a project path.">
        <input type="url" required maxLength={2048} placeholder="https://us.posthog.com" value={origin}
          autoCapitalize="none" spellCheck={false} onChange={(event) => { setOrigin(event.target.value); setKey(""); }} />
      </Field>
      <Field label="PostHog project ID" hint="Use the numeric project ID from PostHog.">
        <input required inputMode="numeric" pattern="[0-9]+" maxLength={100} value={project}
          onChange={(event) => { setProject(event.target.value); setKey(""); }} />
      </Field>
      <Field label={retained ? "Replace PostHog personal API key" : "PostHog personal API key"}
        hint={retained ? "A key is saved for this project. Leave blank to keep it."
          : "Use a personal API key with project read access. It is never shown again."}>
        <input type="password" autoComplete="new-password" value={key} required={!retained && !clearKey} disabled={clearKey}
          maxLength={8192} onChange={(event) => setKey(event.target.value)} />
      </Field>
      {retained && <label className="account-checkbox"><input type="checkbox" checked={clearKey}
        onChange={(event) => { setClearKey(event.target.checked); setKey(""); setEnabled(false); }} />Disconnect and remove saved PostHog key</label>}
      <label className="account-checkbox"><input type="checkbox" checked={recordings}
        onChange={(event) => setRecordings(event.target.checked)} />Include session recording context</label>
      <Field label="Deployment receipt URL"
        hint="Optional public HTTPS endpoint reporting this repository’s deployed commit. Required for automatic landing and watch.">
        <input type="url" maxLength={2048} value={deployment} autoCapitalize="none" spellCheck={false}
          placeholder="https://app.example.org/.well-known/ephyra/deployment.json"
          onChange={(event) => setDeployment(event.target.value)} />
      </Field>
    </fieldset>
    {saved && <div className="connection-status">
      <Tag>{saved.status === "verified" ? "Project access checked" : saved.status === "unavailable" ? "Unavailable" : "Saved, not verified"}</Tag>
      <p className="account-hint">{saved.detail}</p>
      {saved.checkedAt && <small>Last check: {saved.checkedAt}</small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
    <div className="account-actions"><Button type="submit" variant="primary" disabled={write.locked} loading={write.busy}>
      Save PostHog connection
    </Button></div>
  </form>;
}

const roles: InvestigationContact["roles"] = ["maintainer", "operator", "product", "user"];
function PeopleForm({ api, settings, onChange }: AccountPageProps) {
  const saved = settings.people?.workspaceId === settings.workspaceId ? settings.people : undefined;
  const baseline = saved?.contacts ?? [defaultOwner(settings.did)];
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [contacts, setContacts] = useState<InvestigationContact[]>(() => structuredClone(baseline));
  const [areaText, setAreaText] = useState(() => baseline.map((contact) => contact.areas.join(", ")));
  const [webhook, setWebhook] = useState(saved?.webhookUrl ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState<string>();
  const write = useAccountWrite(api, onChange);
  useEffect(() => {
    setEnabled(saved?.enabled ?? true); setContacts(structuredClone(baseline)); setWebhook(saved?.webhookUrl ?? "");
    setAreaText(baseline.map((contact) => contact.areas.join(", ")));
    setToken(""); setClearToken(false); setError(undefined);
  }, [settings]);
  const others = contacts.some((contact) => contact.did !== settings.did);
  const retained = saved?.keyConfigured && webhook.trim() === saved.webhookUrl;
  const dirty = enabled !== (saved?.enabled ?? true) || JSON.stringify(contacts) !== JSON.stringify(baseline) ||
    webhook !== (saved?.webhookUrl ?? "") || Boolean(token || clearToken);
  const change = (index: number, value: Partial<InvestigationContact>) => setContacts((current) =>
    current.map((contact, at) => at === index ? { ...contact, ...value } : contact));
  return <form className="account-form" aria-label="Contact routing" onSubmit={async (event) => {
    event.preventDefault();
    const input = PeopleUpdate.safeParse({ expectedVersion: settings.version, workspaceId: settings.workspaceId, enabled,
      contacts: enabled ? contacts : baseline, webhookUrl: webhook.trim(),
      ...(token.trim() ? { token: token.trim() } : {}), ...(clearToken ? { clearToken: true } : {}),
    });
    if (!input.success) { setError("Each recipient needs a distinct ID, an alias, and at least one role. Check the contact fields."); return; }
    setError(undefined);
    const result = await write.save(input.data, (value, operation) => api.savePeople(value, operation), "Contact routing saved.");
    if (result) setToken("");
  }}>
    <p className="account-hint">Questions for the workspace owner arrive in Inbox without extra setup.
      Add people only when someone else can supply the missing fact. Ephyra chooses a relevant recipient and checks the question and answer.</p>
    <label className="account-checkbox"><input type="checkbox" checked={enabled} disabled={write.locked}
      onChange={(event) => setEnabled(event.target.checked)} />Allow factual questions when investigation is blocked</label>
    <fieldset className="account-fields" disabled={!enabled || write.locked}>
      {contacts.map((contact, index) => <fieldset className="connection-contact" key={index}>
        <legend>{contact.did === settings.did ? "You · Inbox" : contact.alias || "New recipient"}</legend>
        {contact.did === settings.did ? <p className="account-hint">{contact.alias} · {contact.roles.join(", ")}</p> : <>
          <Field label="Recipient ID" hint="The stable ID your delivery service uses for this person.">
            <input required maxLength={160} pattern="[a-zA-Z0-9._:\-]+" value={contact.id}
              autoCapitalize="none" spellCheck={false} onChange={(event) => change(index, { id: event.target.value })} />
          </Field>
          <Field label="Recipient alias"><input required maxLength={100} value={contact.alias}
            onChange={(event) => change(index, { alias: event.target.value })} /></Field>
          <fieldset className="connection-roles"><legend>Roles</legend>
            {roles.map((role) => <label className="account-checkbox" key={role}>
              <input type="checkbox" checked={contact.roles.includes(role)} onChange={(event) => change(index, {
                roles: event.target.checked ? [...contact.roles, role] : contact.roles.filter((value) => value !== role),
              })} />{role}
            </label>)}
          </fieldset>
          <Field label="Areas (optional)" hint="Comma-separated areas such as billing, onboarding or infrastructure.">
            <input value={areaText[index] ?? ""} maxLength={3000} onChange={(event) => {
              const value = event.target.value;
              setAreaText((current) => current.map((text, at) => at === index ? value : text));
              change(index, { areas: value.split(",").map((area) => area.trim()).filter(Boolean) });
            }} />
          </Field>
        </>}
        <Button variant="ghost" size="sm" onClick={() => {
          setContacts((current) => current.filter((_, at) => at !== index));
          setAreaText((current) => current.filter((_, at) => at !== index));
        }}>
          Remove recipient
        </Button>
      </fieldset>)}
      <Button disabled={contacts.length >= 25} onClick={() => {
        setContacts((current) => [...current, { id: "", alias: "", roles: ["maintainer"], areas: [] }]);
        setAreaText((current) => [...current, ""]);
      }}>Add recipient</Button>
      {!contacts.some((contact) => contact.did === settings.did) && <Button variant="ghost"
        onClick={() => {
          setContacts((current) => [defaultOwner(settings.did), ...current]);
          setAreaText((current) => ["", ...current]);
        }}>Restore workspace owner</Button>}
      {(others || webhook) && <div className="account-advanced-fields">
        <p className="account-hint">Other recipients use your authenticated delivery service. It receives the question and a private answer link.</p>
        <Field label="Delivery webhook URL"><input type="url" required={others} maxLength={2048} value={webhook}
          autoCapitalize="none" spellCheck={false} placeholder="https://team.example.org/ephyra/questions"
          onChange={(event) => { setWebhook(event.target.value); setToken(""); setClearToken(false); }} /></Field>
        <Field label={retained ? "Replace delivery token" : "Delivery token"}
          hint={retained ? "A token is saved for this endpoint. Leave blank to keep it." : "Sent only to this delivery endpoint. It is never shown again."}>
          <input type="password" autoComplete="new-password" maxLength={8192} value={token}
            required={others && !retained && !clearToken} disabled={clearToken} onChange={(event) => setToken(event.target.value)} />
        </Field>
        {retained && <label className="account-checkbox"><input type="checkbox" checked={clearToken}
          onChange={(event) => { setClearToken(event.target.checked); setToken(""); }} />Remove saved delivery token</label>}
      </div>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
    <div className="account-actions"><Button type="submit" variant="primary" loading={write.busy} disabled={write.locked || !dirty}>
      Save contact routing
    </Button></div>
  </form>;
}
