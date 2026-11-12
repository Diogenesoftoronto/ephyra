import { createHash, createSign } from "node:crypto";
import { isIP } from "node:net";
import { Unverified, type EvidenceHit, type EvidenceSource } from "@ephyra/core";

export type TelemetryProvider = "sentry" | "crashlytics" | "loki" | "axiom" | "betterstack" | "datadog" | "bugsnag";
export type TelemetryConnection = { id: string; provider: TelemetryProvider; origin: string; project: string; query?: string };
export type TelemetryBinding = TelemetryConnection & { accountId: string; workspaceId: string };
export type TelemetryProviderOptions = {
  connection: TelemetryConnection;
  scope: { accountId: string; workspaceId: string };
  credential: (binding: TelemetryBinding) => Promise<Record<string, string> | null>;
  authorize: (binding: TelemetryBinding) => Promise<boolean>;
  /** Must pin public DNS addresses in production. Credentials are never sent across redirects. */
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  maxBytes?: number;
};
export type TelemetryObservation = {
  source: string;
  events: Array<{ id: string; timestamp: string; message: string; level: string | null; fingerprint: string | null; attributes: Record<string, string> }>;
  coverage: "bounded" | "partial";
  limitations: string[];
  retrievedAt: string;
};
type Obj = Record<string, unknown>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fail = (reason: string): never => { throw new Unverified(`Telemetry ${reason}`); };
const obj = (x: unknown): Obj => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Obj : fail("invalid response");
const rows = (x: unknown, max = 1000): unknown[] => Array.isArray(x) && x.length <= max ? x : fail("invalid or oversized response");
const str = (x: unknown): string => typeof x === "string" ? x : fail("invalid response field");
const maybe = (x: unknown): string | null => x == null ? null : str(x);
const stamp = (x: unknown): string => {
  const s = str(x);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(s)) return fail("invalid timestamp");
  const d = new Date(s.replace(" ", "T") + (/Z$|[+-]\d{2}:?\d{2}$/.test(s) ? "" : "Z"));
  return Number.isFinite(d.getTime()) ? d.toISOString() : fail("invalid timestamp");
};
const json = (x: unknown) => JSON.stringify(x).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
function scrub(s: string, secrets: string[]): string {
  for (const key of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) s = s.replaceAll(key, "[redacted]");
  return s.replace(/(bearer|basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [redacted]")
    .replace(/((?:password|api[_-]?key|access[_-]?token|authorization|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]").slice(0, 12000);
}
function origin(s: string): string {
  let u: URL;
  try { u = new URL(s); } catch { return fail("invalid origin"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || u.pathname !== "/"
    || isIP(u.hostname.replace(/^\[|\]$/g, "")) || !u.hostname.includes(".") || u.hostname.endsWith(".")
    || /(?:^|\.)(localhost|local|internal|test|invalid|onion)$/.test(u.hostname)) return fail("public HTTPS origin required");
  return u.origin;
}
const LIMIT = 50;
const DAY = 86400_000;
const providers: TelemetryProvider[] = ["sentry", "crashlytics", "loki", "axiom", "betterstack", "datadog", "bugsnag"];

/** Bounded read-only samples, never an assertion of complete telemetry or application health. */
export class TelemetryProviderEvidence implements EvidenceSource {
  readonly name: string;
  readonly binding: Readonly<TelemetryBinding>;
  private readonly receipts = new Map<string, string>();
  private token?: { credentialDigest: string; value: string; expiresAt: number };
  constructor(private readonly options: TelemetryProviderOptions) {
    const c = options.connection;
    if (!providers.includes(c.provider) || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id)
      || !c.project || c.project.length > 256 || /[\x00-\x1f]/.test(c.project)
      || (c.query?.length ?? 0) > 2000 || /[\x00-\x1f]/.test(c.query ?? "")
      || !options.scope.accountId || !options.scope.workspaceId) fail("invalid connection");
    this.binding = Object.freeze({ ...c, ...options.scope, origin: origin(c.origin) });
    if (c.provider === "sentry" && !/^[\w-]+\/[\w-]+$/.test(c.project)) fail("Sentry project must be organization/project");
    if (c.provider === "crashlytics" && (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(c.project) || this.binding.origin !== "https://logging.googleapis.com")) fail("invalid Google Cloud project or origin");
    if (c.provider === "betterstack" && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c.project)) fail("invalid Better Stack source table");
    if (c.provider === "axiom" && !/^[a-zA-Z0-9_. -]+$/.test(c.project)) fail("invalid Axiom dataset");
    if (c.provider === "bugsnag" && !/^[a-zA-Z0-9_-]+$/.test(c.project)) fail("invalid BugSnag project");
    if (c.provider === "datadog" && !/^[a-zA-Z0-9_.:/-]+$/.test(c.project)) fail("invalid Datadog service");
    if (c.query && !["loki", "datadog"].includes(c.provider)) fail("this provider does not support custom filters");
    this.name = `telemetry:${c.provider}:${hash(json(this.binding)).slice(0, 24)}`;
  }
  private async allowed() {
    if (!await this.options.authorize(this.binding)) fail("access denied");
  }
  async assertAuthorized(): Promise<void> { await this.allowed(); }
  async verify(): Promise<{ status: "verified"; detail: string }> {
    const batch = await this.observe();
    return { status: "verified", detail: batch.events.length
      ? `Query access checked; ${batch.events.length} recent records retrieved. Coverage remains bounded.`
      : "Query access checked. No recent records returned; instrumentation and application health are not verified." };
  }
  async observe(since?: string): Promise<TelemetryObservation> {
    await this.allowed();
    const credentials = await this.options.credential(this.binding);
    if (!credentials || Object.entries(credentials).some(([key, value]) => typeof value !== "string" || value.length > 16000
      || (key !== "serviceAccountJson" && /[\r\n]/.test(value)))) fail("credential unavailable");
    const secrets = Object.values(credentials!);
    const apiKey = this.binding.provider === "crashlytics" && credentials!.serviceAccountJson
      ? await this.googleToken(credentials!.serviceAccountJson) : credentials!.apiKey;
    if (!apiKey) fail("credential unavailable");
    secrets.push(apiKey!);
    const auth: Record<string, string> = { ...credentials!, apiKey: apiKey! };
    const until = (this.options.now?.() ?? new Date()).toISOString();
    const wanted = since ? stamp(since) : new Date(Date.parse(until) - DAY).toISOString();
    if (Date.parse(wanted) > Date.parse(until)) fail("invalid time window");
    const from = new Date(Math.max(Date.parse(wanted), Date.parse(until) - 7 * DAY)).toISOString();
    const c = this.binding;
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${auth.apiKey}` };
    let path = ""; let body: unknown; let sql: string | undefined;
    const params = new URLSearchParams();
    switch (c.provider) {
      case "sentry":
        path = `/api/0/projects/${c.project.split("/").map(encodeURIComponent).join("/")}/events/`;
        params.set("start", from); params.set("end", until); params.set("full", "true"); params.set("per_page", "10"); break;
      case "crashlytics":
        path = "/v2/entries:list";
        body = { resourceNames: [`projects/${c.project}`], filter: `logName="projects/${c.project}/logs/firebasecrashlytics.googleapis.com%2Fevents" AND timestamp >= "${from}" AND timestamp <= "${until}"`, orderBy: "timestamp desc", pageSize: LIMIT }; break;
      case "loki":
        path = "/loki/api/v1/query_range";
        params.set("query", c.query || `{service_name=${JSON.stringify(c.project)}}`);
        params.set("start", from); params.set("end", until); params.set("limit", String(LIMIT)); params.set("direction", "backward");
        if (auth.username) headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.apiKey}`).toString("base64")}`;
        break;
      case "axiom":
        path = c.origin === "https://api.axiom.co" ? "/v1/datasets/_apl" : "/v1/query/_apl";
        params.set("format", "tabular");
        body = { apl: `[${JSON.stringify(c.project)}] | sort by _time desc | take ${LIMIT}`, startTime: from, endTime: until }; break;
      case "betterstack":
        if (!auth.username) fail("Better Stack username required");
        headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.apiKey}`).toString("base64")}`;
        sql = `SELECT dt, raw FROM remote(${c.project}) WHERE dt >= parseDateTime64BestEffort('${from}') AND dt <= parseDateTime64BestEffort('${until}') ORDER BY dt DESC LIMIT ${LIMIT} FORMAT JSONEachRow`;
        break;
      case "datadog":
        if (!auth.applicationKey) fail("Datadog application key required");
        delete headers.authorization; headers["DD-API-KEY"] = auth.apiKey!; headers["DD-APPLICATION-KEY"] = auth.applicationKey!;
        path = "/api/v2/logs/events/search";
        body = { filter: { from, to: until, query: `service:${c.project}${c.query ? ` AND (${c.query})` : ""}` }, sort: "-timestamp", page: { limit: LIMIT } }; break;
      case "bugsnag":
        headers.authorization = `token ${auth.apiKey}`; headers["X-Version"] = "2";
        path = `/projects/${encodeURIComponent(c.project)}/errors`;
        params.set("sort", "last_seen"); params.set("direction", "desc"); params.set("per_page", String(LIMIT));
        params.set("filters[event.since][0][type]", "eq"); params.set("filters[event.since][0][value]", from); break;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    if (sql !== undefined) headers["content-type"] = "text/plain";
    const url = `${c.origin}${path}${params.size ? `?${params}` : ""}`;
    let response: Response;
    let text: string;
    try {
      await this.allowed();
      response = await this.options.fetcher(url, { method: body !== undefined || sql !== undefined ? "POST" : "GET", headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : sql !== undefined ? { body: sql } : {}),
        redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (!response.ok || response.redirected) fail(response.status === 401 || response.status === 403 ? "credential rejected or expired" : response.status === 429 ? "rate limited" : "query unavailable");
      text = await this.read(response);
    } catch (e) { if (e instanceof Unverified) throw e; return fail("request failed"); }
    await this.allowed();
    let raw: unknown;
    try { raw = c.provider === "betterstack" ? text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [] : JSON.parse(text); }
    catch { return fail("invalid JSON response"); }
    let parsed: TelemetryObservation["events"];
    try { parsed = this.decode(raw); } catch (error) { if (error instanceof Unverified) throw error; return fail("invalid provider response"); }
    // Log stores contain ordinary activity too. Only explicit error severities become signals.
    if (!["sentry", "crashlytics", "bugsnag"].includes(c.provider)) {
      parsed = parsed.filter(e => ["error", "fatal", "critical", "alert", "emergency", "panic", "err"].includes(e.level?.toLowerCase() ?? ""));
    }
    const events = parsed.map(e => ({ ...e, message: scrub(e.message, secrets),
      level: e.level === null ? null : scrub(e.level, secrets), fingerprint: e.fingerprint === null ? null : scrub(e.fingerprint, secrets),
      attributes: Object.fromEntries(Object.entries(e.attributes).map(([k, v]) => [k, scrub(v, secrets)])),
    })).filter(e => e.timestamp >= from && e.timestamp <= until).slice(0, LIMIT);
    const limitations = ["Only a bounded recent sample was queried; pagination, sampling, retention and delayed delivery may omit records. Log stores emit signals only for explicit error severities.",
      "No records is not proof of healthy software or a successful fix. Requests may incur provider query charges."];
    if (c.provider === "bugsnag") limitations.push("BugSnag records are issue summaries at last_seen, not individual crash occurrences.");
    if (c.provider === "betterstack") limitations.push("Only the selected remote hot-storage table is queried; archived S3 data is excluded.");
    if (c.provider === "crashlytics") limitations.push("Requires enabled Firebase Cloud Logging export. Service-account credentials refresh OAuth tokens automatically; manually supplied access tokens expire and require renewal.");
    if (c.provider === "axiom" && c.origin === "https://api.axiom.co") limitations.push("Legacy Axiom queries route through US East 1; use the dataset's edge origin for regional queries and cost-limited tokens.");
    await this.allowed();
    return { source: this.name, events, coverage: "partial", limitations, retrievedAt: until };
  }
  private async googleToken(serviceAccountJson: string): Promise<string> {
    const now = (this.options.now?.() ?? new Date()).getTime();
    const digest = hash(serviceAccountJson);
    await this.allowed();
    if (this.token?.credentialDigest === digest && this.token.expiresAt > now + 60_000) return this.token.value;
    let account: Obj;
    let assertion: string;
    try {
      account = obj(JSON.parse(serviceAccountJson));
      if (account.type !== "service_account" || typeof account.project_id !== "string"
        || typeof account.client_email !== "string" || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(account.client_email)
        || typeof account.private_key !== "string" || !account.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) fail("invalid Google service account");
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email,
        scope: "https://www.googleapis.com/auth/logging.read", aud: "https://oauth2.googleapis.com/token",
        iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 })}`;
      assertion = `${payload}.${createSign("RSA-SHA256").update(payload).sign(account.private_key as string, "base64url")}`;
    } catch { return fail("invalid Google service account"); }
    try {
      await this.allowed();
      const response = await this.options.fetcher("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
      if (!response.ok || response.redirected) fail("Google service account authorization unavailable");
      const result = obj(JSON.parse(await this.read(response)));
      await this.allowed();
      if (typeof result.access_token !== "string" || !result.access_token || /[\r\n]/.test(result.access_token)
        || result.access_token.length > 8192 || result.token_type !== "Bearer" || typeof result.expires_in !== "number"
        || !Number.isFinite(result.expires_in) || result.expires_in <= 60) fail("invalid Google token response");
      this.token = { credentialDigest: digest, value: result.access_token as string, expiresAt: now + Math.min(result.expires_in as number, 3600) * 1000 };
      return this.token!.value;
    } catch (error) { if (error instanceof Unverified) throw error; return fail("Google token exchange failed"); }
  }
  private async read(response: Response): Promise<string> {
    const max = Math.min(this.options.maxBytes ?? 2_000_000, 2_000_000);
    if (Number(response.headers.get("content-length")) > max) fail("response too large");
    if (!response.body) fail("empty response");
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > max) { await reader.cancel(); fail("response too large"); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  }
  private decode(raw: unknown): TelemetryObservation["events"] {
    const c = this.binding;
    const event = (id: unknown, time: unknown, message: unknown, level: unknown, fingerprint: unknown, attributes: Record<string, string> = {}) => {
      const rawId = str(id); if (!rawId || rawId.length > 1024) fail("invalid record identity");
      return { id: hash(`${this.name}:${rawId}`), timestamp: stamp(time), message: str(message), level: maybe(level), fingerprint: maybe(fingerprint), attributes: { providerRecordId: rawId, ...attributes } };
    };
    switch (c.provider) {
      case "sentry": return rows(raw).map(x => {
        const r = obj(x); const attrs: Record<string, string> = {};
        for (const v of rows(r.tags ?? [], 200)) { const t = obj(v); if (["release", "environment", "os", "device", "level"].includes(String(t.key))) attrs[String(t.key)] = str(t.value); }
        if (r.entries) {
          const exceptions = rows(r.entries, 100).map(obj).filter(e => e.type === "exception");
          const frames = exceptions.flatMap(e => rows(obj(e.data).values, 50).map(obj)).map(e => ({ type: e.type, value: e.value,
            frames: e.stacktrace ? rows(obj(e.stacktrace).frames, 500).slice(-30).map(f => { const a = obj(f); return { filename: a.filename, function: a.function, lineNo: a.lineNo, inApp: a.inApp }; }) : [] }));
          attrs.exception = json(frames);
        }
        return event(r.eventID ?? r.id, r.dateCreated ?? r.datetime, r.message ?? r.title ?? "", r.level ?? attrs.level, r.groupID ?? null, attrs);
      });
      case "crashlytics": return rows(obj(raw).entries ?? []).map(x => {
        const r = obj(x); const p = obj(r.jsonPayload); const issue = obj(p.issue); const attrs: Record<string, string> = {};
        for (const name of ["version", "device", "operatingSystem"] as const) if (p[name]) {
          const v = obj(p[name]); for (const key of ["displayVersion", "buildVersion", "model", "manufacturer", "name", "version"]) if (typeof v[key] === "string") attrs[`${name}.${key}`] = str(v[key]);
        }
        return event(r.insertId ?? hash(json(r)), r.timestamp, [issue.title, issue.subtitle].filter(x => typeof x === "string").join(": "), issue.errorType ?? r.severity, issue.id, attrs);
      });
      case "loki": {
        const r = obj(raw); if (r.status !== "success") return fail("Loki query failed"); const data = obj(r.data);
        if (data.resultType !== "streams") return fail("Loki requires a log stream query");
        return rows(data.result).flatMap(x => { const stream = obj(x); const labels = obj(stream.stream);
          return rows(stream.values).map(v => { const tuple = rows(v, 3); const ns = str(tuple[0]);
            if (!/^\d{10,22}$/.test(ns)) return fail("invalid Loki timestamp");
            const time = new Date(Number(BigInt(ns) / 1000000n)).toISOString();
            let message = str(tuple[1]); let level = labels.level ?? labels.detected_level;
            try { const payload = JSON.parse(message); if (payload && typeof payload === "object" && !Array.isArray(payload)) {
              level ??= payload.level ?? payload.severity; message = typeof payload.message === "string" ? payload.message : message;
            } } catch { /* ordinary text log */ }
            return event(hash(json([labels, tuple])), time, message, level, null,
              Object.fromEntries(["service_name", "app", "namespace"].filter(k => typeof labels[k] === "string").map(k => [k, str(labels[k])])));
          }); });
      }
      case "axiom": {
        const r = obj(raw); const status = obj(r.status); if (typeof status.isPartial !== "boolean") fail("invalid Axiom status");
        return rows(r.tables, 10).flatMap(t => { const table = obj(t); const fields = rows(table.fields, 200).map(f => str(obj(f).name));
          const columns = rows(table.columns, 200).map(v => rows(v)); if (fields.length !== columns.length || !fields.includes("_time")) fail("invalid Axiom columns");
          const count = columns[0]?.length ?? 0; if (columns.some(col => col.length !== count)) fail("invalid Axiom column lengths");
          return Array.from({ length: count }, (_, i) => { const row: Obj = Object.fromEntries(fields.map((f, j) => [f, columns[j]![i]]));
            return event(row._rowId ?? row._cursor ?? hash(json(row)), row._time, row.message ?? row.msg ?? row.body ?? "", row.level ?? row.severity, null); });
        });
      }
      case "betterstack": return rows(raw).map(x => { const r = obj(x); let payload: Obj;
        try { payload = typeof r.raw === "string" ? obj(JSON.parse(r.raw)) : obj(r.raw); } catch { return fail("invalid Better Stack log payload"); }
        return event(hash(json(r)), r.dt, payload.message ?? payload.msg ?? "", payload.level ?? payload.severity, null);
      });
      case "datadog": return rows(obj(raw).data).map(x => { const r = obj(x); const a = obj(r.attributes);
        return event(r.id, a.timestamp, a.message, a.status, null, typeof a.service === "string" ? { service: a.service } : {}); });
      case "bugsnag": return rows(raw).map(x => { const r = obj(x); return event(`${str(r.id)}:${str(r.last_seen)}`, r.last_seen,
        [r.error_class, r.message, r.context].filter(x => typeof x === "string").join(": "), r.severity ?? r.original_severity, r.id, { recordKind: "issue_summary" }); });
    }
  }
  async search(query: Parameters<EvidenceSource["search"]>[0]): Promise<EvidenceHit[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > LIMIT || query.text.length > 4000) fail("invalid search");
    const batch = await this.observe(query.since);
    const terms = [...new Set(query.text.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [])].slice(0, 32);
    const ranked = batch.events.map(event => ({ event, score: event.fingerprint && event.fingerprint === query.fingerprint ? 1
      : terms.length ? terms.filter(t => event.message.toLowerCase().includes(t)).length / terms.length : 0 })).sort((a, b) => b.score - a.score);
    const selected = ranked.length ? ranked.slice(0, query.limit) : [{ event: null, score: 0 }];
    const hits = selected.map(({ event, score }) => {
      const content = json({ ...batch, events: event ? [event] : [] }); const id = hash(content); this.receipts.set(id, content);
      return { source: this.name, id, title: `${this.binding.provider}: ${event ? "recorded observation" : "no records in queried sample"}`,
        score, snippet: `<untrusted_telemetry>${content}</untrusted_telemetry>` };
    });
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    return hits;
  }
  async fetch(hit: EvidenceHit): Promise<{ mediaType: string; content: string }> {
    await this.allowed(); const content = hit.source === this.name ? this.receipts.get(hit.id) : undefined;
    if (!content) return fail("unknown evidence receipt");
    return { mediaType: "application/json", content };
  }
}
