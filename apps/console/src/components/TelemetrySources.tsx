import { useEffect, useId, useRef, useState } from "react";
import { TelemetrySourceUpdate, type TelemetryProvider } from "@ephyra/core";
import { Button, Field, Tag } from "../kit.ts";
import { AccountSaveFeedback, type AccountPageProps } from "./AccountForms.tsx";
import { useAccountWrite } from "./useAccountWrite.ts";
import { TELEMETRY_PROVIDERS, type TelemetryProviderInfo } from "./telemetry-catalog.ts";
import "./TelemetrySources.css";

export function ProviderLogo({ file }: { file: string }) {
  return <img className={`telemetry-logo${file.endsWith(".svg") ? " telemetry-logo--mono" : ""}`}
    src={`${import.meta.env?.BASE_URL ?? "/app/"}providers/${file}`} width={28} height={28} alt="" aria-hidden="true" />;
}

export function TelemetrySources(props: AccountPageProps) {
  const [selected, setSelected] = useState<TelemetryProvider | null>(null);
  const [detected, setDetected] = useState<TelemetryProvider[]>([]);
  const formId = useId();
  useEffect(() => {
    let current = true;
    setDetected([]);
    if (props.settings.repository) void props.api.detectedTelemetry().then((result) => {
      if (current) setDetected(result.providers);
    }).catch(() => { /* Detection is advisory; manually connecting a provider remains available. */ });
    return () => { current = false; };
  }, [props.api, props.settings.did, props.settings.workspaceId, props.settings.repository?.head]);
  const sources = (props.settings.telemetrySources ?? []).filter((source) => source.workspaceId === props.settings.workspaceId);
  const provider = TELEMETRY_PROVIDERS.find((item) => item.id === selected);
  return <section className="telemetry-sources" aria-label="Application signals">
    <div className="telemetry-sources__intro"><h2>Connect application signals</h2>
      <p className="account-hint">Give Ephyra the errors and logs you already collect. Choose a source to check access and connect it to this workspace.</p>
    </div>
    <div className="telemetry-provider-list" aria-label="Telemetry providers">
      {TELEMETRY_PROVIDERS.map((item) => {
        const saved = sources.find((source) => source.provider === item.id);
        return <button key={item.id} type="button" className="telemetry-provider" aria-pressed={selected === item.id}
          aria-controls={formId} onClick={() => setSelected((value) => value === item.id ? null : item.id)}>
          <ProviderLogo file={item.logo} /><span className="telemetry-provider__text"><strong>{item.name}</strong><span>{item.description}</span></span>
          {saved?.enabled ? <Tag>{saved.status === "verified" ? "Access checked"
        : saved.status === "unavailable" ? "Needs attention" : "Saved"}</Tag>
            : detected.includes(item.id) ? <Tag>Detected</Tag> : <span className="telemetry-provider__action">Connect</span>}
        </button>;
      })}
    </div>
    {detected.length > 0 && <p className="account-hint">Detected means the repository contains an integration reference.
      Access and incoming data still need checking.</p>}
    <div id={formId}>
      {provider && <TelemetrySourceForm key={`${props.settings.did}:${props.settings.workspaceId}:${provider.id}`} {...props} provider={provider} />}
    </div>
    <details className="account-advanced telemetry-collector">
      <summary><ProviderLogo file="opentelemetry.svg" />OpenTelemetry, mobile SDKs and Railway</summary>
      <div className="account-advanced-fields">
        <p className="account-hint">Already exporting telemetry? Keep your existing collector.
          These paths need collector configuration, rather than a provider account connection above.</p>
        <div className="telemetry-setup-path"><ProviderLogo file="embrace.png" /><div><strong>Embrace and mobile OpenTelemetry</strong>
          <p>Forward mobile logs and traces through an authenticated collector.
            Bind the app's service and release to this repository. Verify a received event before relying on coverage.</p>
          <a href="https://embrace.io/docs/flutter/features/traces/" target="_blank" rel="noreferrer">Read Embrace export instructions</a></div></div>
        <div className="telemetry-setup-path"><ProviderLogo file="railway.svg" /><div><strong>Railway application logs</strong>
          <p>Forward application output with Vector or Fluent Bit, or configure the application's OpenTelemetry exporter.
            Railway does not provide a log-drain setting.</p>
          <a href="https://docs.railway.com/observability/logs" target="_blank" rel="noreferrer">Read Railway logging instructions</a></div></div>
        <CollectorSetup key={`${props.settings.did}:${props.settings.workspaceId}`} {...props} />
        <p className="account-hint">For iOS and Android, also configure debug symbols, app version and build identifiers.
          A source connection alone does not verify instrumentation or a repair.</p>
      </div>
    </details>
  </section>;
}

export function TelemetrySourceForm({ api, settings, onChange, provider }: AccountPageProps & { provider: TelemetryProviderInfo }) {
  const saved = settings.telemetrySources?.find((source) => source.workspaceId === settings.workspaceId && source.provider === provider.id);
  const [origin, setOrigin] = useState(saved?.origin ?? provider.origin);
  const [project, setProject] = useState(saved?.project ?? "");
  const [query, setQuery] = useState(saved?.query ?? "");
  const [key, setKey] = useState("");
  const [applicationKey, setApplicationKey] = useState("");
  const [username, setUsername] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [googleAuth, setGoogleAuth] = useState<"service-account" | "token">("service-account");
  const [error, setError] = useState<string>();
  const write = useAccountWrite(api, onChange);
  useEffect(() => {
    setOrigin(saved?.origin ?? provider.origin); setProject(saved?.project ?? ""); setQuery(saved?.query ?? "");
    setKey(""); setApplicationKey(""); setUsername(""); setServiceAccountJson(""); setError(undefined);
  }, [settings, provider.id]);
  const retained = Boolean(saved?.enabled && saved.keyConfigured && saved.origin.replace(/\/$/, "") === origin.trim().replace(/\/$/, "") &&
    saved.project === project.trim() && (saved.query ?? "") === query.trim());
  const clearCredentials = () => { setKey(""); setApplicationKey(""); setUsername(""); setServiceAccountJson(""); };
  async function save(enabled: boolean) {
    const value = TelemetrySourceUpdate.safeParse({
      id: saved?.id ?? provider.id, provider: provider.id, workspaceId: settings.workspaceId, expectedVersion: settings.version,
      enabled, origin: origin.trim(), project: project.trim(), ...(query.trim() ? { query: query.trim() } : {}),
      ...(!enabled ? { clearKey: true } : provider.id === "crashlytics" && googleAuth === "service-account" && serviceAccountJson.trim()
        ? { credentials: { serviceAccountJson: serviceAccountJson.trim() } } : key.trim() ? { credentials: { apiKey: key.trim(),
        ...(applicationKey.trim() ? { applicationKey: applicationKey.trim() } : {}), ...(username.trim() ? { username: username.trim() } : {}) } } : {}),
    });
    if (!value.success) { setError("Check the source address, project and credentials."); return; }
    if (enabled && !retained && !key.trim() && !serviceAccountJson.trim()) { setError("Add credentials for this source before checking access."); return; }
    if (enabled && (applicationKey.trim() || username.trim()) && !key.trim()) {
      setError("Supply the complete credential set when replacing saved credentials."); return; }
    if (enabled && key.trim() && provider.id === "datadog" && !applicationKey.trim()) { setError("Add both the API key and application key."); return; }
    if (enabled && key.trim() && provider.id === "betterstack" && !username.trim()) { setError("Add the Query API username and password."); return; }
    setError(undefined);
    const result = await write.save(value.data, (input, operation) => api.saveTelemetrySource(input, operation),
      enabled ? `${provider.name} settings saved. See the access result below.` : `${provider.name} disconnected.`);
    if (result) clearCredentials();
  }
  return <form className="account-form telemetry-source-form" aria-label={`${provider.name} connection`}
    onSubmit={(event) => { event.preventDefault(); void save(true); }}>
    <div className="telemetry-source-form__heading"><ProviderLogo file={provider.logo} /><h3>{provider.name}</h3>
      <a href={provider.docs} target="_blank" rel="noreferrer">Setup instructions<span className="sr-only"> for {provider.name}</span></a></div>
    <fieldset className="account-fields" disabled={write.locked}>
      <Field label={provider.id === "betterstack" ? "Query API origin" : "API origin"}
        hint="Use the HTTPS address for your region or instance, without a query or credentials.">
        <input type="url" required maxLength={2048} value={origin} placeholder={provider.origin || "https://logs.example.org"}
          autoCapitalize="none" spellCheck={false} onChange={(event) => { setOrigin(event.target.value); clearCredentials(); }} />
      </Field>
      <Field label={provider.projectLabel} hint={provider.projectHint}>
        <input required maxLength={300} value={project} placeholder={provider.projectPlaceholder} autoCapitalize="none" spellCheck={false}
          onChange={(event) => { setProject(event.target.value); clearCredentials(); }} />
      </Field>
      {provider.queryHint && <Field label="LogQL query (optional)" hint={provider.queryHint}>
        <input maxLength={2000} value={query} placeholder={provider.queryPlaceholder} spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); clearCredentials(); }} />
      </Field>}
      {provider.id === "crashlytics" && <Field label="Google authentication"
        hint="A service account can refresh access automatically. A temporary token expires.">
        <select value={googleAuth} onChange={(event) => { setGoogleAuth(event.target.value as "service-account" | "token"); clearCredentials(); }}>
          <option value="service-account">Service account (recommended)</option><option value="token">Temporary access token</option>
        </select>
      </Field>}
      {provider.id === "crashlytics" && googleAuth === "service-account" ? <Field label="Service account JSON"
        hint={retained ? "A credential is saved. Leave blank to keep it, or paste a replacement JSON key."
          : "Use a service account with Logs Viewer (roles/logging.viewer) on this project. "
            + "The key is stored encrypted and is never shown again."}>
        <textarea required={!retained} maxLength={16000} value={serviceAccountJson} autoComplete="off" spellCheck={false}
          onChange={(event) => setServiceAccountJson(event.target.value)} />
      </Field> : <Field label={retained ? `Replace ${provider.keyLabel.toLowerCase()}` : provider.keyLabel}
        hint={retained ? "Credentials are saved for this source. Leave blank to keep them, or replace the complete credential set." : provider.keyHint}>
        <input type="password" autoComplete="new-password" required={!retained} maxLength={8192} value={key}
          onChange={(event) => setKey(event.target.value)} />
      </Field>}
      {provider.id === "datadog" && <Field label="Application key" hint="Requires logs_read_data permission. Supply both keys when replacing credentials.">
        <input type="password" autoComplete="new-password" required={!retained || Boolean(key)} maxLength={8192} value={applicationKey}
          onChange={(event) => setApplicationKey(event.target.value)} />
      </Field>}
      {(provider.id === "betterstack" || provider.id === "loki") && <Field
        label={provider.id === "loki" ? "Basic auth username (optional)" : "Query API username"}
        hint={provider.id === "loki" ? "Leave blank when your endpoint accepts a bearer token." : "Copy this with your password from Query with."}>
        <input autoComplete="off" required={provider.id === "betterstack" && (!retained || Boolean(key))} maxLength={8192} value={username}
          onChange={(event) => setUsername(event.target.value)} />
      </Field>}
    </fieldset>
    {provider.id === "crashlytics" && <p className="account-hint">This reads the Cloud Logging export, not data directly from your device.
      Export delays and token expiry can interrupt coverage.</p>}
    {saved && <div className="connection-status" role="status">
      <Tag>{saved.enabled ? saved.status === "verified" ? "Access checked"
        : saved.status === "unavailable" ? "Unavailable" : "Saved, not verified" : "Disconnected"}</Tag>
      <p className="account-hint">{saved.detail}</p>
      {saved.checkedAt && <small>Last check: <time dateTime={saved.checkedAt}>{saved.checkedAt}</time></small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
    <div className="account-actions">
      <Button type="submit" variant="primary" disabled={write.locked} loading={write.busy}>Check access and save</Button>
      {saved?.enabled && <Button type="button" variant="ghost" disabled={write.locked} onClick={() => void save(false)}>Disconnect {provider.name}</Button>}
    </div>
    <p className="account-hint">Checking access reads a bounded sample. It does not run an agent or prove the application is healthy.</p>
  </form>;
}


function CollectorSetup({ api, settings }: AccountPageProps) {
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof api.telemetryOtlp>>>();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const traces = connection?.endpoint.replace(/\/v1\/logs$/, "/v1/traces");
  async function load() {
    setState("loading"); setCopied(false);
    try {
      const next = await api.telemetryOtlp();
      if (!current.current) return;
      if (next.workspaceId !== settings.workspaceId || !next.repository || !/\/v1\/logs$/.test(next.endpoint)) throw new Error("scope");
      setConnection(next); setState("ready");
    } catch { if (current.current) { setConnection(undefined); setState("error"); } }
  }
  return <section className="telemetry-collector-setup" aria-label="Collector connection">
    <h3>Connect your collector</h3>
    <p className="account-hint">Use these settings on a trusted server-side collector.
      Keep its token out of browser code and mobile app binaries; send client telemetry through your collector.</p>
    {!settings.repository ? <p className="account-hint">Connect a repository first to get its scoped ingestion endpoint.</p>
      : !connection && <Button disabled={state === "loading"} loading={state === "loading"} onClick={() => void load()}>Get collector settings</Button>}
    {state === "error" && <p role="alert">Collector settings could not be loaded for this workspace. Try again.</p>}
    {connection && <div className="account-fields">
      <Field label="Logs endpoint"><input readOnly value={connection.endpoint} /></Field>
      <Field label="Traces endpoint"><input readOnly value={traces} /></Field>
      <Field label="Collector token" hint="Send as an Authorization: Bearer header. Keep this credential private.">
        <input type={reveal ? "text" : "password"} autoComplete="off" readOnly value={connection.token} />
      </Field>
      <label className="account-checkbox"><input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.target.checked)} />
        Show collector token</label>
      <p className="account-hint">Protocol: OTLP over HTTP, Protobuf. Copy these environment variables into your trusted exporter configuration.</p>
      <Button onClick={async () => {
        try {
          await navigator.clipboard.writeText([
            "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
            `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${connection.endpoint}`,
            `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${traces}`,
            `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20${encodeURIComponent(connection.token)}`, "",
          ].join("\n"));
          if (current.current) setCopied(true);
        } catch { if (current.current) setCopied(false); }
      }}>Copy collector environment</Button>
      <p role="status" className="account-hint">{copied ? "Collector settings copied, including the private token."
        : "These settings are credentials. Copy only into trusted configuration."}</p>
    </div>}
  </section>;
}
