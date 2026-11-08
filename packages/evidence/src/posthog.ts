import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Unverified, type EvidenceHit, type EvidenceSource } from "@ephyra/core";

export type PostHogScope = { accountId: string; workspaceId: string };
export type PostHogBinding = PostHogScope & { origin: string; projectId: string };
export type PostHogEvidenceOptions = {
  /** Trusted server configuration. Never supplied by a model or an evidence hit. */
  origin: string;
  projectId: string;
  scope: PostHogScope;
  credential: (binding: PostHogBinding) => Promise<string | null>;
  authorize: (binding: PostHogBinding) => Promise<boolean>;
  /** Production callers must inject a transport that checks and pins public DNS addresses. */
  fetcher: (url: string, init?: Parameters<typeof fetch>[1]) => Promise<Response>;
  includeRecordings?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  lookbackMs?: number;
  now?: () => Date;
};
export type PostHogAccessStatus = "missing_credential" | "denied" | "missing_scope" | "rate_limited"
  | "unavailable" | "invalid_response" | "timeout" | "invalid_reference";
export class PostHogAccessError extends Unverified {
  constructor(readonly status: PostHogAccessStatus) {
    super(`PostHog ${status}; evidence is unavailable`);
    this.name = "PostHogAccessError";
  }
}
export type PostHogFrame = { filename: string | null; function: string | null; lineno: number | null; colno: number | null; inApp: boolean | null };
export type PostHogException = {
  id: string;
  timestamp: string;
  event: "$exception";
  fingerprint: string | null;
  level: string | null;
  exceptions: { type: string | null; message: string | null; frames: PostHogFrame[]; truncated: boolean }[];
  steps: { timestamp: string | null; message: string }[];
  sessionId: string | null;
  recordingUrl: string | null;
  /** A session ID does not establish that recording was enabled, retained or accessible. */
  recordingAvailability: "unverified" | "no_session_id";
  truncated: boolean;
};
export type PostHogCursor = { source: string; since: string; until: string; timestamp: string; eventId: string };
export type PostHogExceptionBatch = {
  source: string;
  projectId: string;
  retrievedAt: string;
  window: { requestedSince: string | null; since: string; until: string; clamped: boolean };
  status: "observed" | "no_data";
  coverage: "bounded" | "partial";
  retention: "unknown";
  freshness: { cached: boolean | null; lastRefresh: string | null; state: "fresh" | "stale" | "unknown" };
  reference: { endpoint: string; queryDigest: string; queryName: string };
  events: PostHogException[];
  nextCursor: PostHogCursor | null;
  /** Re-poll inclusively and deduplicate event IDs: late-arriving events require an overlap window. */
  nextSince: string;
  limitations: string[];
};
export type PostHogRecording = {
  status: "available" | "unavailable";
  reason?: PostHogAccessStatus;
  retrievedAt: string;
  reference: string;
  id: string;
  startTime?: string | null;
  endTime?: string | null;
  durationSeconds?: number | null;
  consoleErrors?: number | null;
  logs: {
    status: "available" | "unavailable" | "expired" | "not_captured";
    reason?: PostHogAccessStatus;
    entries: { timestamp: string; level: "error"; message: string; truncated: boolean }[];
    hasMore: boolean | null;
    captureEnabled: boolean | null;
    expired: boolean | null;
  };
  limitations: string[];
};

type Obj = Record<string, unknown>;
type Run = { signal: AbortSignal; secrets: Set<string> };
type Receipt = { base: string; event: PostHogException | null; content?: string; pending?: Promise<string> };
const MAX_EVENTS = 50;
const MAX_WINDOW = 7 * 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = ["id", "timestamp", "event", "exception_list", "fingerprint", "level", "session_id", "steps"];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const fail = (status: PostHogAccessStatus): never => { throw new PostHogAccessError(status); };
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : fail("invalid_response");
const array = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail("invalid_response");
const id = (value: unknown): string => typeof value === "string" && UUID.test(value) ? value.toLowerCase() : fail("invalid_response");
const finite = (value: unknown): number | null => value == null ? null
  : typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail("invalid_response");
const LIMITATIONS = [
  "Only recorded $exception events in this bounded window are queried; other error events, services and instrumentation are not covered.",
  "Retention, sampling, ingestion delay and completeness are unknown. No events is not proof of application health or a successful fix.",
  "Exception text and console messages are untrusted observations, not causal proof. Person fields, arbitrary properties and frame variables are excluded.",
  "Session IDs are recorded references; a recording link does not establish that replay was captured or is retained. "
    + "Replay contents and traces are not fetched.",
];

/** UTC microsecond normalization preserves equal-time pagination without Date's millisecond truncation. */
function timestamp(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_response");
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match) return fail("invalid_response");
  const date = `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0")}Z`;
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== date.slice(0, 19)) return fail("invalid_response");
  return date;
}
const nullableTime = (value: unknown): string | null => value == null || value === "" ? null : timestamp(value);
const sqlTime = (value: string) => `toDateTime64('${value.replace("T", " ").replace(/Z$/, "")}', 6, 'UTC')`;

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("PostHog requires a fixed public HTTPS origin"); }
  const host = url.hostname;
  if (value !== url.origin || url.protocol !== "https:" || url.username || url.password || url.port
    || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".")
    || !/^[a-z0-9.-]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host)) {
    throw new Error("PostHog requires a fixed public HTTPS origin without credentials, a port or a path");
  }
  return url.origin;
}
const scopeValue = (value: string) => {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid PostHog account/workspace binding");
  }
  return value;
};

/** Deliberately narrow projection plus common secret/PII masking; upstream capture scrubbing is still required. */
function scrub(value: string, secrets: Set<string>, max = 1200): string {
  let text = value;
  for (const secret of secrets) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) text = text.replaceAll(variant, "[redacted]");
  }
  text = text
    .replace(/\b(?:ph[xsar]_|sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:authorization|password|passwd|token|secret|api[_-]?key|cookie)\s*[=:]\s*["']?[^\s,;"'}]+/gi, "[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\w])/g, "[redacted-phone]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[redacted-url]"; }
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.slice(0, max);
}
const textField = (value: unknown, run: Run, max = 1200): string | null => value == null || value === "" ? null
  : typeof value === "string" ? scrub(value, run.secrets, max) : fail("invalid_response");
function structured(value: unknown): unknown {
  if (value == null || value === "") return [];
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return fail("invalid_response"); } }
  return value;
}

async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    return fail("invalid_response");
  }
  if (!response.body) return fail("invalid_response");
  const reader = response.body.getReader();
  const stop = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) return fail("timeout");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return fail("invalid_response");
      chunks.push(value);
    }
    if (signal.aborted) return fail("timeout");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener("abort", stop); stop(); }
}

/** Fixed read-only queries for a single authorized PostHog project; no remote URL/SQL from model input. */
export class PostHogEvidence implements EvidenceSource {
  readonly name: string;
  private readonly binding: PostHogBinding;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly lookbackMs: number;
  private readonly receipts = new Map<string, Receipt>();
  private readonly options: PostHogEvidenceOptions;

  constructor(options: PostHogEvidenceOptions) {
    this.options = { ...options };
    if (!/^[1-9]\d{0,15}$/.test(options.projectId)) throw new Error("PostHog requires an explicit numeric project ID");
    this.binding = { origin: origin(options.origin), projectId: options.projectId,
      accountId: scopeValue(options.scope.accountId), workspaceId: scopeValue(options.scope.workspaceId) };
    this.name = `posthog:${this.binding.projectId}:${hash(json(this.binding)).slice(0, 16)}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.lookbackMs = options.lookbackMs ?? 24 * 60 * 60_000;
    if (![this.timeoutMs, this.maxBytes, this.lookbackMs].every((n) => Number.isSafeInteger(n) && n > 0)
      || this.timeoutMs > 25_000 || this.maxBytes > 2_000_000 || this.lookbackMs > MAX_WINDOW) throw new Error("Invalid PostHog evidence limits");
    if (typeof options.fetcher !== "function" || typeof options.authorize !== "function") throw new Error("PostHog requires an authorized public transport");
  }

  /** Recheck the current server-side grant without fetching project data. */
  async assertAuthorized(): Promise<void> { return this.run((run) => this.allowed(run)); }

  private now() { return this.options.now?.() ?? new Date(); }
  private async allowed(run: Run) {
    if (run.signal.aborted) return fail("timeout");
    if (!await this.options.authorize({ ...this.binding })) return fail("denied");
    if (run.signal.aborted) return fail("timeout");
  }
  private async run<T>(fn: (run: Run) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PostHogAccessError("timeout")); }, this.timeoutMs);
    });
    try { return await Promise.race([fn({ signal: controller.signal, secrets: new Set() }), deadline]); }
    catch (error) { if (error instanceof PostHogAccessError) throw error; return fail("unavailable"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  private async request(path: string, run: Run, body?: unknown): Promise<unknown> {
    await this.allowed(run);
    const token = await this.options.credential({ ...this.binding });
    if (typeof token !== "string" || token.length < 16 || token.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(token)) return fail("missing_credential");
    run.secrets.add(token);
    await this.allowed(run);
    const response = await this.options.fetcher(`${this.binding.origin}/api/projects/${this.binding.projectId}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: run.signal,
      redirect: "error", credentials: "omit", cache: "no-store",
    });
    if (run.signal.aborted || response.redirected || response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return fail(run.signal.aborted ? "timeout" : response.status === 401 ? "denied" : response.status === 403 ? "missing_scope"
        : response.status === 429 ? "rate_limited" : "unavailable");
    }
    let result: unknown;
    try { result = await boundedJson(response, this.maxBytes, run.signal); }
    catch (error) { if (error instanceof PostHogAccessError) throw error; return fail("invalid_response"); }
    await this.allowed(run);
    return result;
  }

  private event(value: unknown, run: Run): PostHogException {
    const row = array(value, COLUMNS.length);
    if (row.length !== COLUMNS.length || row[2] !== "$exception") return fail("invalid_response");
    const chain = array(structured(row[3]), 100);
    const steps = array(structured(row[7]), 1000);
    const sessionId = row[6] == null || row[6] === "" ? null : id(row[6]);
    let truncated = chain.length > 3 || steps.length > 10;
    const exceptions = chain.slice(0, 3).map((raw) => {
      const entry = object(raw);
      const stack = entry.stacktrace == null ? {} : object(entry.stacktrace);
      const frames = stack.frames == null ? [] : array(stack.frames, 1000);
      const trimmed = frames.length > 20 || [entry.type, entry.value].some((v) => typeof v === "string" && v.length > 1200);
      truncated ||= trimmed;
      return { type: textField(entry.type, run, 120), message: textField(entry.value, run), truncated: trimmed,
        frames: frames.slice(-20).map((rawFrame): PostHogFrame => {
          const frame = object(rawFrame);
          return { filename: textField(frame.filename, run, 500), function: textField(frame.function, run, 160),
            lineno: finite(frame.lineno), colno: finite(frame.colno), inApp: typeof frame.in_app === "boolean" ? frame.in_app : null };
        }) };
    });
    return { id: id(row[0]), timestamp: timestamp(row[1]), event: "$exception", fingerprint: textField(row[4], run, 256),
      level: textField(row[5], run, 32), exceptions,
      steps: steps.slice(-10).map((raw) => {
        const step = object(raw);
        return { timestamp: nullableTime(step.$timestamp), message: textField(step.$message, run) ?? "" };
      }),
      sessionId, recordingUrl: sessionId ? `${this.binding.origin}/project/${this.binding.projectId}/replay/${sessionId}` : null,
      recordingAvailability: sessionId ? "unverified" : "no_session_id", truncated };
  }

  /** One bounded page of actual events. Persist the cursor and deduplicate IDs when ingesting; no signal is synthesized. */
  async exceptions(since?: string, cursor?: PostHogCursor): Promise<PostHogExceptionBatch> {
    return this.queryExceptions(since, cursor);
  }

  private async queryExceptions(since?: string, cursor?: PostHogCursor, newest = false): Promise<PostHogExceptionBatch> {
    return this.run(async (run) => {
      await this.allowed(run);
      const now = this.now();
      const untilNow = timestamp(now.toISOString());
      const requested = since === undefined ? null : timestamp(since);
      const minimum = timestamp(new Date(now.getTime() - MAX_WINDOW).toISOString());
      let from = requested ?? timestamp(new Date(now.getTime() - this.lookbackMs).toISOString());
      let until = untilNow;
      let after = "";
      let clamped = from < minimum;
      if (clamped) from = minimum;
      if (cursor) {
        if (cursor.source !== this.name || cursor.since !== timestamp(cursor.since) || cursor.until !== timestamp(cursor.until)
          || cursor.until < minimum || cursor.until > untilNow || cursor.since >= cursor.until
          || Date.parse(cursor.until) - Date.parse(cursor.since) > MAX_WINDOW
          || (requested !== null && requested !== cursor.since
            && !(requested < cursor.since && Date.parse(cursor.until) - Date.parse(cursor.since) === MAX_WINDOW))) return fail("invalid_reference");
        const at = timestamp(cursor.timestamp);
        const eventId = id(cursor.eventId);
        if (at < cursor.since || at >= cursor.until) return fail("invalid_reference");
        from = cursor.since; until = cursor.until; clamped = requested !== null && requested < from;
        after = ` AND (timestamp > ${sqlTime(at)} OR (timestamp = ${sqlTime(at)} AND toString(uuid) > '${eventId}'))`;
      }
      if (from >= until) return fail("invalid_reference");
      const query = "SELECT toString(uuid) AS id, toTimeZone(timestamp, 'UTC') AS timestamp, event, "
        + "properties.$exception_list AS exception_list, properties.$exception_fingerprint AS fingerprint, "
        + "properties.$exception_level AS level, properties.$session_id AS session_id, properties.$exception_steps AS steps "
        + `FROM events WHERE event = '$exception' AND timestamp >= ${sqlTime(from)} AND timestamp < ${sqlTime(until)}${after} `
        + `ORDER BY timestamp ${newest ? "DESC" : "ASC"}, toString(uuid) ${newest ? "DESC" : "ASC"} LIMIT ${MAX_EVENTS + 1}`;
      const queryName = newest ? "ephyra_recent_exceptions" : "ephyra_recorded_exceptions";
      const raw = object(await this.request("query/", run, { query: { kind: "HogQLQuery", query }, name: queryName, refresh: "force_blocking" }));
      if (raw.error || raw.exception || raw.query_status && object(raw.query_status).complete !== true) return fail("unavailable");
      if (raw.team_id !== undefined && String(raw.team_id) !== this.binding.projectId
        || raw.query_status && object(raw.query_status).team_id !== undefined
          && String(object(raw.query_status).team_id) !== this.binding.projectId) return fail("invalid_response");
      if (raw.columns !== undefined && json(raw.columns) !== json(COLUMNS)) return fail("invalid_response");
      const events = array(raw.results, MAX_EVENTS + 1).map((row) => this.event(row, run));
      let previous = cursor ? `${timestamp(cursor.timestamp)}:${id(cursor.eventId)}` : "";
      for (const event of events) {
        const key = `${event.timestamp}:${event.id}`;
        if (event.timestamp < from || event.timestamp >= until || previous && (newest ? key >= previous : key <= previous)) return fail("invalid_response");
        previous = key;
      }
      const more = events.length > MAX_EVENTS;
      const selected = events.slice(0, MAX_EVENTS);
      const last = selected.at(-1);
      const lastRefresh = nullableTime(raw.last_refresh);
      const cached = typeof raw.is_cached === "boolean" ? raw.is_cached : null;
      const stale = lastRefresh !== null && (Date.parse(lastRefresh) < now.getTime() - 5 * 60_000 || Date.parse(lastRefresh) > now.getTime() + 60_000);
      const result: PostHogExceptionBatch = {
        source: this.name, projectId: this.binding.projectId, retrievedAt: this.now().toISOString(),
        window: { requestedSince: requested, since: from, until, clamped }, status: selected.length ? "observed" : "no_data",
        coverage: more || clamped || stale || selected.some((e) => e.truncated) ? "partial" : "bounded", retention: "unknown",
        freshness: { cached, lastRefresh, state: stale ? "stale" : lastRefresh || cached === false ? "fresh" : "unknown" },
        reference: { endpoint: `${this.binding.origin}/api/projects/${this.binding.projectId}/query/`, queryDigest: hash(query), queryName },
        events: selected, nextCursor: more && last && !newest ? { source: this.name, since: from, until, timestamp: last.timestamp, eventId: last.id } : null,
        nextSince: more && last ? last.timestamp : until,
        limitations: [...LIMITATIONS, ...(more ? [newest ? "Only the latest 50 events are included in this research sample."
          : "Additional events exist; resume using nextCursor before advancing the polling window."] : []),
          ...(clamped ? ["Requested history exceeded seven days; older events were not queried."] : [])],
      };
      await this.allowed(run);
      return result;
    });
  }

  async search(query: Parameters<EvidenceSource["search"]>[0]): Promise<EvidenceHit[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50
      || typeof query.text !== "string" || query.text.length > 4000) return fail("invalid_reference");
    const batch = await this.queryExceptions(query.since, undefined, true);
    return this.run(async (run) => {
      await this.allowed(run);
      const terms = [...new Set(query.text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].slice(0, 32);
      const ranked = batch.events.map((event) => {
        const haystack = json(event).toLowerCase();
        const lexicalMatches = terms.filter((term) => haystack.includes(term)).length;
        const fingerprintMatch = query.fingerprint !== undefined && query.fingerprint === event.fingerprint;
        return { event, lexicalMatches, fingerprintMatch, score: fingerprintMatch ? 1 : terms.length ? lexicalMatches / terms.length : 0 };
      }).sort((a, b) => b.score - a.score || b.event.timestamp.localeCompare(a.event.timestamp));
      // Return a coverage receipt even with no events: absence must retain its window and limitations.
      const selections = ranked.length ? ranked.slice(0, query.limit) : [{ event: null, lexicalMatches: 0, fingerprintMatch: false, score: 0 }];
      const hits = selections.map(({ event, lexicalMatches, fingerprintMatch, score }): EvidenceHit => {
        const base = json({ ...batch, events: event ? [event] : [], nextCursor: undefined,
          search: { lexicalMatches, fingerprintMatch, rankedWithin: batch.events.length, omittedEvents: Math.max(0, batch.events.length - selections.length),
            causalMatch: "not_established" } });
        const receiptId = hash(`${this.name}:${base}:${this.options.includeRecordings === true}`);
        if (!this.receipts.has(receiptId)) this.receipts.set(receiptId, { base, event: event ? structuredClone(event) : null });
        while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
        return { source: this.name, id: receiptId, title: event ? `PostHog exception ${event.id}` : "PostHog: no recorded exceptions in queried window",
          score, snippet: `<untrusted_posthog>${base}</untrusted_posthog>` };
      });
      await this.allowed(run);
      return hits;
    });
  }

  private async recording(event: PostHogException, run: Run): Promise<PostHogRecording> {
    const sessionId = event.sessionId!;
    const path = `session_recordings/${sessionId}/`;
    const result: PostHogRecording = { status: "unavailable", retrievedAt: this.now().toISOString(), id: sessionId,
      reference: `${this.binding.origin}/api/projects/${this.binding.projectId}/${path}`,
      logs: { status: "unavailable", entries: [], hasMore: null, captureEnabled: null, expired: null },
      limitations: ["Recording metadata and captured console errors only; replay contents, person data and traces are not included."] };
    try {
      const raw = object(await this.request(path, run));
      if (id(raw.id) !== sessionId || raw.team_id !== undefined && String(raw.team_id) !== this.binding.projectId) return fail("invalid_response");
      result.status = "available";
      result.startTime = nullableTime(raw.start_time); result.endTime = nullableTime(raw.end_time);
      result.durationSeconds = finite(raw.recording_duration); result.consoleErrors = finite(raw.console_error_count);
    } catch (error) {
      if (!(error instanceof PostHogAccessError) || error.status === "denied" || error.status === "timeout") throw error;
      result.reason = error.status; return result;
    }
    try {
      const raw = object(await this.request(`${path}console_logs/?level=error&limit=20&offset=0`, run));
      if (typeof raw.has_more !== "boolean" || typeof raw.console_log_capture_enabled !== "boolean"
        || typeof raw.logs_expired !== "boolean") return fail("invalid_response");
      const entries = array(raw.results, 20).map((entry) => {
        const row = object(entry);
        if (row.level !== "error" || typeof row.message !== "string" || typeof row.truncated !== "boolean") return fail("invalid_response");
        return { timestamp: timestamp(row.timestamp), level: "error" as const, message: scrub(row.message, run.secrets),
          truncated: row.truncated || row.message.length > 1200 };
      });
      result.logs = { status: raw.logs_expired ? "expired" : !raw.console_log_capture_enabled ? "not_captured" : "available",
        entries, hasMore: raw.has_more, captureEnabled: raw.console_log_capture_enabled, expired: raw.logs_expired };
    } catch (error) {
      if (!(error instanceof PostHogAccessError) || error.status === "denied" || error.status === "timeout") throw error;
      result.logs.reason = error.status;
    }
    return result;
  }

  async fetch(hit: EvidenceHit): Promise<{ mediaType: string; content: string }> {
    return this.run(async (run) => {
      await this.allowed(run);
      const receipt = hit.source === this.name ? this.receipts.get(hit.id) : undefined;
      if (!receipt) return fail("invalid_reference");
      if (!receipt.content) {
        if (!receipt.pending) receipt.pending = (async () => {
          const recording = this.options.includeRecordings && receipt.event?.sessionId ? await this.recording(receipt.event, run) : null;
          await this.allowed(run);
          return json({ ...JSON.parse(receipt.base), recording, recordingRequested: this.options.includeRecordings === true,
            receipt: { source: this.name, id: hit.id, searchDigest: hash(receipt.base) } });
        })();
        try { receipt.content = await receipt.pending; }
        finally { delete receipt.pending; }
      }
      await this.allowed(run);
      return { mediaType: "application/json", content: receipt.content };
    });
  }
}
