import { createHash } from "node:crypto";
import { ReconciliationRequired, Signal, type OperationLedger, type StackFrame } from "@ephyra/core";
import { fingerprint, redact } from "@ephyra/ingest";
import { PostHogAccessError, type PostHogCursor, type PostHogEvidence, type PostHogException, type PostHogExceptionBatch } from "@ephyra/evidence";
import type { ServerContext } from "../wiring/context.ts";

export type PostHogPollInput = { source?: string; since?: string; cursor?: PostHogCursor };
export type PostHogPollCoverage = {
  windowSince: string | null; windowUntil: string | null;
  /** Oldest actual computation watermark across all queried pages; never the retrieval time. */
  computedThrough: string | null;
  computation: "upstream_timestamp" | "uncached_query_window" | "unknown";
  complete: boolean; gaps: string[];
};
export type PostHogPollResult = {
  status: "complete" | "partial" | "inactive" | "unavailable" | "reconciliation_required";
  source: string | null;
  pages: number;
  observed: number;
  ingested: number;
  duplicates: number;
  reconciliationRequired: number;
  nextCursor: PostHogCursor | null;
  nextSince: string | null;
  /** Safe machine status only, never an upstream error body. */
  reason?: string;
  coverage?: PostHogPollCoverage;
};
export type PostHogObservation = { at: string; result: PostHogPollResult };
export type PostHogPollingOptions = {
  ctx: ServerContext;
  resolve: () => Promise<PostHogEvidence | null>;
  ledger: OperationLedger;
  /** The intake hook, which durably enqueues triage by signal ID. Must not send messages directly. */
  onSignal: (signal: Signal) => Promise<void>;
  intervalMs?: number;
  overlapMs?: number;
  maxPages?: number;
  /** Receives a real bounded pass, never an inferred healthy state. */
  onObservation?: (observation: PostHogObservation) => Promise<void>;
};
export type PostHogPolling = {
  /** Pass the saved connection revision on settings changes to restart promptly within the current time bucket. */
  start: (revision?: string) => Promise<void>;
  /** One bounded ingestion pass. Returned continuation can be persisted or supplied to the next manual pass. */
  poll: (input?: PostHogPollInput) => Promise<PostHogPollResult>;
  /** In-memory observation, reauthorized and freshness checked; a restart needs a new pass. */
  latest: () => Promise<PostHogObservation | null>;
  /** Prevents further work by this registration, including queued jobs. Does not delete durable receipts. */
  stop: () => void;
};

type PollJob = PostHogPollInput & { source: string; cycle: string; page: number };
const KIND = "posthog_poll";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const sourceName = (value: unknown): value is string => typeof value === "string" && /^posthog:[1-9]\d{0,15}:[a-f0-9]{16}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validCursor = (value: unknown): value is PostHogCursor => {
  if (!value || typeof value !== "object") return false;
  const cursor = value as PostHogCursor;
  return sourceName(cursor.source) && safeTime(cursor.since) && safeTime(cursor.until) && safeTime(cursor.timestamp) && uuid(cursor.eventId);
};

/** Deterministic local signal UUID; the original event UUID remains separately attributed. */
function signalId(source: string, repo: string, eventId: string): string {
  const bytes = Buffer.from(digest(["posthog-signal-v1", source, repo, eventId]).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Maps recorded fields only. Unknown environment and frame ownership are not labelled production/application. */
export function postHogSignal(repo: string, batch: PostHogExceptionBatch, event: PostHogException): Signal {
  const first = event.exceptions[0];
  const frames: StackFrame[] = event.exceptions.flatMap((exception) => exception.frames).slice(-60)
    .filter((frame) => frame.filename !== null)
    .map((frame) => ({ file: redact(frame.filename!), inApp: frame.inApp === true,
      ...(frame.function ? { fn: redact(frame.function) } : {}),
      ...(frame.lineno !== null && Number.isSafeInteger(frame.lineno) ? { line: frame.lineno } : {}),
      ...(frame.colno !== null && Number.isSafeInteger(frame.colno) ? { column: frame.colno } : {}) }));
  const message = redact(event.exceptions.map((exception) => [exception.type, exception.message].filter(Boolean).join(": "))
    .filter(Boolean).join("\n")).slice(0, 8000);
  const kind = first?.type ? redact(first.type) : undefined;
  const attributedFingerprint = event.fingerprint
    ? `posthog-v1:${digest([batch.source, repo, event.fingerprint])}`
    : `posthog-v1:${digest([batch.source, repo, fingerprint({ message, exceptionType: kind, frames })])}`;
  const attributes: Record<string, string> = {
    "posthog.project_id": batch.projectId, "posthog.event_id": event.id, "posthog.event_timestamp": event.timestamp,
    "posthog.query_digest": batch.reference.queryDigest, "posthog.retrieved_at": batch.retrievedAt,
    "posthog.coverage": batch.coverage, "posthog.retention": batch.retention,
    "posthog.freshness": batch.freshness.state, "posthog.recording_availability": event.recordingAvailability,
    "posthog.truncated": String(event.truncated), "posthog.frame_ownership": "unknown unless explicitly reported",
  };
  if (event.fingerprint) attributes["posthog.fingerprint"] = redact(event.fingerprint);
  if (event.sessionId) attributes["posthog.session_id"] = event.sessionId;
  if (event.recordingUrl) attributes["posthog.recording_url"] = event.recordingUrl;
  return Signal.parse({ schema: 1, id: signalId(batch.source, repo, event.id), kind: "error", repo,
    environment: "unknown", source: batch.source, fingerprint: attributedFingerprint,
    title: (message || "Recorded PostHog exception; message unavailable").slice(0, 300), message,
    ...(kind ? { exceptionType: kind } : {}), frames,
    firstSeen: event.timestamp, lastSeen: event.timestamp, count: 1, attributes });
}

/** Registers one durable polling lane. Queue payloads contain only scoped cursors, never credentials or event content. */
export function registerPostHogPolling(options: PostHogPollingOptions): PostHogPolling {
  const { ctx, resolve, ledger, onSignal } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const overlapMs = options.overlapMs ?? 5 * 60_000;
  const maxPages = options.maxPages ?? 2;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 24 * 60 * 60_000
    || !Number.isSafeInteger(overlapMs) || overlapMs < intervalMs || overlapMs > 24 * 60 * 60_000
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error("Invalid PostHog polling bounds");
  let stopped = false;
  let observation: PostHogObservation | null = null;

  const current = async (expected?: string): Promise<PostHogEvidence | null> => {
    if (stopped) return null;
    const source = await resolve();
    if (!source || expected !== undefined && source.name !== expected || stopped) return null;
    await source.assertAuthorized();
    return stopped ? null : source;
  };
  const empty = (): PostHogPollResult => ({ status: "inactive", source: null, pages: 0, observed: 0,
    ingested: 0, duplicates: 0, reconciliationRequired: 0, nextCursor: null, nextSince: null,
    coverage: { windowSince: null, windowUntil: null, computedThrough: null, computation: "unknown", complete: false, gaps: [] } });
  const note = (result: PostHogPollResult) => ctx.log("PostHog polling", {
    status: result.status, source: result.source, pages: result.pages, observed: result.observed,
    ingested: result.ingested, duplicates: result.duplicates, reconciliationRequired: result.reconciliationRequired,
    ...(result.reason ? { reason: result.reason } : {}), hasContinuation: result.nextCursor !== null,
  });
  const finish = async (result: PostHogPollResult) => {
    note(result);
    observation = { at: ctx.clock.now().toISOString(), result: structuredClone(result) };
    try { await options.onObservation?.(structuredClone(observation)); }
    catch { ctx.log("Bootstrap observation update unavailable"); }
    return result;
  };

  const poll = async (input: PostHogPollInput = {}): Promise<PostHogPollResult> => {
    const result = empty();
    if (input.source !== undefined && !sourceName(input.source) || input.since !== undefined && !safeTime(input.since)
      || input.cursor !== undefined && !validCursor(input.cursor)) throw new Error("Invalid PostHog polling cursor");
    let since = input.since;
    let cursor = input.cursor;
    result.nextSince = since ?? null; result.nextCursor = cursor ?? null;
    try {
      let source = await current(input.source ?? cursor?.source);
      if (!source) return finish(result);
      result.source = source.name;
      for (let page = 0; page < maxPages; page++) {
        const batch = await source.exceptions(since, cursor);
        result.pages++;
        const coverage = result.coverage!;
        if (coverage.windowSince === null) { coverage.windowSince = batch.window.since; coverage.windowUntil = batch.window.until; }
        if (coverage.windowSince !== batch.window.since || coverage.windowUntil !== batch.window.until) {
          coverage.gaps.push("Query pages did not cover the same fixed window.");
        }
        const refresh = batch.freshness.lastRefresh;
        if (refresh !== null && Date.parse(refresh) > Date.parse(batch.retrievedAt) + 5000) {
          coverage.gaps.push("Query computation timestamp is in the future.");
        }
        const watermark = refresh !== null
          ? new Date(Math.min(Date.parse(refresh), Date.parse(batch.window.until))).toISOString()
          : batch.freshness.cached === false ? batch.window.until : null;
        if (watermark === null) coverage.gaps.push("Query computation time is unknown.");
        else {
          if (Date.parse(watermark) < Date.parse(batch.window.since)) coverage.gaps.push("Query computation predates its requested window.");
          if (coverage.computedThrough === null || Date.parse(watermark) < Date.parse(coverage.computedThrough)) {
            coverage.computedThrough = watermark;
          }
          coverage.computation = refresh !== null ? "upstream_timestamp" : "uncached_query_window";
        }
        if (batch.window.clamped) coverage.gaps.push("Requested query history was clamped.");
        if (batch.events.some(event => event.truncated)) coverage.gaps.push("Exception evidence was truncated.");
        if (batch.coverage === "partial" && !batch.nextCursor) coverage.gaps.push("The terminal query page has partial coverage.");
        if (batch.freshness.state !== "fresh") {
          result.status = "unavailable"; result.reason = "stale_or_unknown_computation"; return finish(result);
        }
        for (const event of batch.events) {
          source = await current(result.source);
          if (!source) { result.status = "inactive"; return finish(result); }
          result.observed++;
          const signal = postHogSignal(ctx.repo.id, batch, event);
          const key = `posthog-event:${digest([ctx.repo.id, batch.source, event.id])}`;
          const plan = digest({ operation: "posthog_ingest_v1", repo: ctx.repo.id, source: batch.source, eventId: event.id });
          let claim: Awaited<ReturnType<OperationLedger["begin"]>>;
          try { claim = await ledger.begin(key, plan); }
          catch (error) {
            if (!(error instanceof ReconciliationRequired)) throw error;
            result.reconciliationRequired++; continue;
          }
          if (!claim.fresh) {
            const receipt = claim.record.result as { status?: string; source?: string; eventId?: string; signalId?: string } | undefined;
            if (claim.record.status === "done" && receipt?.status === "ingested" && receipt.source === batch.source
              && receipt.eventId === event.id && uuid(receipt.signalId)) result.duplicates++;
            else result.reconciliationRequired++;
            continue;
          }
          try {
            // Once claimed, ambiguous outcomes never repeat a count increment or triage dispatch.
            if (!await current(result.source)) throw new PostHogAccessError("denied");
            const stored = await ctx.signals.upsert(signal);
            const shouldTriage = stored.isNew && !await ctx.signals.isMuted(signal.fingerprint, ctx.clock.now());
            if (shouldTriage) {
              if (!await current(result.source)) throw new PostHogAccessError("denied");
              await onSignal(stored.signal);
            }
            await ledger.complete(key, { status: "ingested", signalId: stored.signal.id, eventId: event.id,
              timestamp: event.timestamp, source: batch.source, triageEnqueued: shouldTriage, signalDigest: digest(signal) });
            result.ingested++;
          } catch {
            result.reconciliationRequired++;
            try { await ledger.markAmbiguous(key, "PostHog ingestion outcome requires reconciliation; do not repeat automatically"); }
            catch { /* A pending durable claim is also a no-retry boundary. */ }
          }
        }
        result.nextCursor = batch.nextCursor;
        result.nextSince = batch.nextSince;
        if (!batch.nextCursor) break;
        cursor = batch.nextCursor;
        since = batch.window.since;
      }
      result.status = result.reconciliationRequired ? "reconciliation_required" : result.nextCursor ? "partial" : "complete";
      result.coverage!.gaps = [...new Set(result.coverage!.gaps)];
      result.coverage!.complete = result.status === "complete" && result.coverage!.computedThrough !== null && !result.coverage!.gaps.length;
      return finish(result);
    } catch (error) {
      if (error instanceof PostHogAccessError) {
        result.reason = error.status;
        result.status = ["denied", "missing_credential", "missing_scope"].includes(error.status) ? "inactive" : "unavailable";
      } else {
        result.status = "unavailable"; result.reason = "polling_failed";
      }
      return finish(result);
    }
  };

  const enqueue = async (job: PollJob, runAt?: Date) => {
    const key = `posthog-poll:${digest([ctx.repo.id, job.source, job.cycle, job.page, job.cursor ?? null])}`;
    await ctx.jobs.enqueue(KIND, key, job, runAt ? { runAt } : undefined);
  };
  ctx.jobs.register(KIND, async (payload) => {
    const job = payload as Partial<PollJob> | null;
    if (!job || !sourceName(job.source) || typeof job.cycle !== "string" || !/^[a-f0-9]{64}$/.test(job.cycle)
      || !Number.isSafeInteger(job.page) || job.page! < 0 || job.page! > 10_000) throw new Error("Invalid PostHog polling job");
    const result = await poll(job);
    if (stopped || result.status === "inactive" || !result.source) return;
    try { if (!await current(result.source)) return; }
    catch { throw new Error("PostHog polling authorization could not be checked before scheduling"); }
    if (result.nextCursor) {
      await enqueue({ source: result.source, since: result.nextCursor.since, cursor: result.nextCursor,
        cycle: job.cycle, page: job.page! + 1 }, new Date(ctx.clock.now().getTime() + (result.status === "unavailable" ? intervalMs : 1000)));
      return;
    }
    const nextAt = new Date((Math.floor(ctx.clock.now().getTime() / intervalMs) + 1) * intervalMs);
    const nextSince = result.status === "unavailable" ? job.since : result.nextSince
      ? new Date(Date.parse(result.nextSince) - overlapMs).toISOString() : job.since;
    await enqueue({ source: result.source, ...(nextSince ? { since: nextSince } : {}),
      cycle: digest(["scheduled", Math.floor(nextAt.getTime() / intervalMs)]), page: 0 }, nextAt);
  });

  return {
    poll,
    latest: async () => {
      if (!observation || stopped) return null;
      const age = ctx.clock.now().getTime() - Date.parse(observation.at);
      if (age < 0 || age > Math.max(intervalMs * 3, 5 * 60_000)) return null;
      try {
        const source = await current(observation.result.source ?? undefined);
        if (!source || source.name !== observation.result.source) return null;
        return structuredClone(observation);
      } catch { return null; }
    },
    stop: () => { stopped = true; observation = null; },
    start: async (revision = "") => {
      if (typeof revision !== "string" || revision.length > 256) throw new Error("Invalid PostHog connection revision");
      stopped = false;
      let source: PostHogEvidence | null;
      try { source = await current(); }
      catch { ctx.log("PostHog polling", { status: "inactive", reason: "connection_unavailable" }); return; }
      if (!source) return;
      const slot = Math.floor(ctx.clock.now().getTime() / intervalMs);
      await enqueue({ source: source.name, cycle: digest(["start", slot, revision]), page: 0 });
    },
  };
}
