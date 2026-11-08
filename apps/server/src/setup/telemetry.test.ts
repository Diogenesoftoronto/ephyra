import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Signal, type Journal, type OperationLedger, type Trail } from "@ephyra/core";
import { PostHogEvidence, WatchCollector, type PostHogExceptionBatch } from "@ephyra/evidence";
import { MemorySignalStore } from "@ephyra/ingest";
import { evaluateWatch, parseAutonomy } from "@ephyra/policy";
import { FakeContext, type ServerContext } from "../wiring/context.ts";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { KnowledgeOperationLedger } from "./knowledge-ledger.ts";
import { postHogSignal, registerPostHogPolling } from "./telemetry.ts";
import { personalLanding } from "./personal-landing.ts";
import type { Accounts } from "./accounts.ts";
import type { GitProbeCatalog } from "../wiring/probes.ts";

const NOW = "2026-11-08T12:00:00.000Z";
const AT = "2026-11-08T11:30:00.123456Z";
const uuid = (n: number) => `019b1807-e3a1-7001-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, fingerprint = "cart-error") => [uuid(n), AT, "$exception", [{ type: "TypeError", value: "Cart unavailable",
  stacktrace: { frames: [{ filename: "src/cart.ts", function: "add", lineno: 8, colno: 2, in_app: true },
    { filename: "app.js", function: "call" }] } }], fingerprint, "error", null, []];
const columns = ["id", "timestamp", "event", "exception_list", "fingerprint", "level", "session_id", "steps"];
const data = (rows: unknown[], extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ columns, results: rows,
  is_cached: false, last_refresh: NOW, ...extra }));
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

function fixture(count = 1) {
  let now = new Date(NOW);
  let connected = true;
  let authorized = true;
  let httpStatus = 200;
  let cached = false;
  let extra: Record<string, unknown> = {};
  let requests = 0;
  const signals = new MemorySignalStore();
  const ctx = new FakeContext({ id: "repo-one", url: "https://github.com/acme/app.git", mirrorDir: "/tmp/unused", baseRef: "main", forge: "plain", remote: "origin" },
    {} as ServerContext["policy"], {} as Journal, signals, { now: () => now });
  const source = new PostHogEvidence({ origin: "https://us.posthog.com", projectId: "42", scope: { accountId: "did:alice", workspaceId: "workspace-one" },
    authorize: async () => authorized, credential: async () => "phx_fixture_only_not_a_real_credential", now: () => now,
    fetcher: async (_url, init) => {
      requests++;
      if (httpStatus !== 200) return new Response("private upstream body", { status: httpStatus });
      const sql = JSON.parse(init!.body as string).query.query as string;
      const after = /toString\(uuid\) > '([^']+)'/.exec(sql)?.[1];
      const rows = Array.from({ length: count }, (_, n) => row(n + 1)).filter((r) => !after || String(r[0]) > after).slice(0, 51);
      return data(rows, { ...(cached ? { is_cached: true, last_refresh: "2026-11-07T00:00:00Z" } : {}), ...extra });
    } });
  const sent: Signal[] = [];
  const ledger = new MemoryOperationLedger();
  const deps = { ctx, resolve: async () => connected ? source : null, ledger, onSignal: async (signal: Signal) => { sent.push(signal); } };
  const polling = registerPostHogPolling(deps);
  const runNext = async () => {
    const next = ctx.queued.shift()!;
    expect(next).toBeDefined();
    await ctx.jobRunners.get(next.kind)!(next.payload, { key: next.key, attempt: 1 });
    return next;
  };
  return { ctx, source, signals, sent, ledger, deps, polling, runNext,
    requests: () => requests, disconnect: () => { connected = false; }, revoke: () => { authorized = false; },
    status: (value: number) => { httpStatus = value; }, stale: () => { cached = true; },
    response: (value: Record<string, unknown>) => { extra = value; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

async function personalWatch(f: ReturnType<typeof fixture>) {
  f.ctx.policy.autonomy = parseAutonomy("# Test policy\n## defaults\nwatch: 1m\n## area: application\npaths: **\nrisk: medium\n");
  const repository = { url: "https://git.example.org/application.git", branch: "main" };
  const accounts = { record: async () => ({ settings: { workspaceId: "workspace-one", repository,
    telemetry: { enabled: true, workspaceId: "workspace-one", deploymentUrl: "https://deploy.example.org/receipt" } } }) } as unknown as Accounts;
  const factory = personalLanding({ accounts, did: "did:alice", workspace: "workspace-one" });
  const landing = await factory({ ctx: f.ctx, ledger: f.ledger, probes: {} as GitProbeCatalog,
    runProbe: async () => { throw new Error("No probe is dispatched by this coverage-only fixture"); }, telemetry: f.polling });
  return landing.watch!;
}

describe("PostHog signal polling", () => {
  test("maps recorded event attribution with stable scoped IDs and conservative unknown fields", async () => {
    const f = fixture();
    const batch = await f.source.exceptions();
    const signal = postHogSignal(f.ctx.repo.id, batch, batch.events[0]!);
    expect(signal).toMatchObject({ kind: "error", repo: "repo-one", environment: "unknown", count: 1,
      firstSeen: AT, lastSeen: AT, exceptionType: "TypeError", message: "TypeError: Cart unavailable",
      frames: [{ file: "src/cart.ts", inApp: true, line: 8 }, { file: "app.js", inApp: false }] });
    expect(signal.attributes["posthog.event_id"]).toBe(uuid(1));
    expect(signal.attributes["posthog.event_timestamp"]).toBe(AT);
    expect(signal.attributes["posthog.retention"]).toBe("unknown");
    expect(signal.traceId).toBeUndefined();
    expect(signal.id).not.toBe(uuid(1));
    expect(postHogSignal(f.ctx.repo.id, batch, batch.events[0]!)).toEqual(signal);
  });

  test("stable mapping is independent of retrieval time and distinct across repositories and event IDs", async () => {
    const f = fixture();
    const batch = await f.source.exceptions();
    fc.assert(fc.property(fc.integer({ min: 1, max: 999_999 }), fc.string({ minLength: 1, maxLength: 64 }), (n, suffix) => {
      const event = { ...batch.events[0]!, id: uuid(n) };
      const first = postHogSignal("repo-a", batch, event);
      const same = postHogSignal("repo-a", { ...batch, retrievedAt: "2026-11-08T12:01:00Z" }, event);
      const other = postHogSignal(`repo-b:${suffix}`, batch, event);
      expect(Signal.safeParse(first).success).toBe(true);
      expect(first.id).toBe(same.id); expect(first.fingerprint).toBe(same.fingerprint);
      expect(first.id).not.toBe(other.id); expect(first.fingerprint).not.toBe(other.fingerprint);
    }), { numRuns: 50 });
  });

  test("each actual event increments once; repeated errors merge and only the new fingerprint enters triage", async () => {
    const f = fixture(2);
    const first = await f.polling.poll();
    expect(first).toMatchObject({ status: "complete", observed: 2, ingested: 2, duplicates: 0 });
    expect(f.sent).toHaveLength(1);
    const stored = await f.signals.byFingerprint(f.sent[0]!.fingerprint);
    expect(stored!.count).toBe(2);
    const repeat = await f.polling.poll();
    expect(repeat).toMatchObject({ ingested: 0, duplicates: 2 });
    expect((await f.signals.byFingerprint(f.sent[0]!.fingerprint))!.count).toBe(2);
    expect(f.sent).toHaveLength(1);
  });

  test("muted fingerprints are still counted but do not enqueue triage", async () => {
    const f = fixture();
    const batch = await f.source.exceptions();
    const signal = postHogSignal(f.ctx.repo.id, batch, batch.events[0]!);
    await f.signals.mute(signal.fingerprint, new Date(new Date(NOW).getTime() + 60_000));
    expect((await f.polling.poll()).ingested).toBe(1);
    expect(f.sent).toHaveLength(0);
    expect((await f.signals.byFingerprint(signal.fingerprint))!.count).toBe(1);
  });

  test("bounded passes keep equal-timestamp continuation and durable jobs finish the remaining backlog", async () => {
    const f = fixture(151);
    await f.polling.start();
    await f.runNext();
    expect(f.requests()).toBe(2);
    expect(f.ctx.queued).toHaveLength(1);
    const next = f.ctx.queued[0]!;
    expect(next.payload).toMatchObject({ cursor: { eventId: uuid(100), timestamp: AT } });
    expect(next.runAt!.getTime()).toBe(new Date(NOW).getTime() + 1000);
    await f.runNext();
    expect(f.requests()).toBe(4);
    expect((await f.signals.byFingerprint(f.sent[0]!.fingerprint))!.count).toBe(151);
    expect(f.sent).toHaveLength(1);
    expect(f.ctx.queued[0]!.payload).toMatchObject({ since: "2026-11-08T11:55:00.000Z", page: 0 });
    expect((f.ctx.queued[0]!.payload as { cursor?: unknown }).cursor).toBeUndefined();
  });

  test("manual polling returns its bounded continuation without silently advancing past backlog", async () => {
    const f = fixture(151);
    const first = await f.polling.poll();
    expect(first.status).toBe("partial"); expect(first.nextCursor!.eventId).toBe(uuid(100));
    expect(f.ctx.queued).toHaveLength(0);
    const next = await f.polling.poll({ source: first.source!, since: first.nextCursor!.since, cursor: first.nextCursor! });
    expect(next).toMatchObject({ status: "complete", ingested: 51, nextCursor: null });
    expect((await f.signals.byFingerprint(f.sent[0]!.fingerprint))!.count).toBe(151);
  });

  test("durable per-event receipts survive a new registration and file-ledger instance", async () => {
    const f = fixture();
    const dir = await mkdtemp(join(tmpdir(), "ephyra-telemetry-ledger-")); dirs.push(dir);
    const first = registerPostHogPolling({ ...f.deps, ledger: new KnowledgeOperationLedger(dir) });
    expect((await first.poll()).ingested).toBe(1);
    const restarted = registerPostHogPolling({ ...f.deps, ledger: new KnowledgeOperationLedger(dir) });
    expect((await restarted.poll()).duplicates).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect((await f.signals.byFingerprint(f.sent[0]!.fingerprint))!.count).toBe(1);
  });

  test("ambiguous triage dispatch is recorded and never automatically repeated", async () => {
    const f = fixture();
    let calls = 0;
    const polling = registerPostHogPolling({ ...f.deps, onSignal: async () => { calls++; throw new Error("secret provider outcome"); } });
    const result = await polling.poll();
    expect(result).toMatchObject({ status: "reconciliation_required", reconciliationRequired: 1, ingested: 0 });
    const repeat = await polling.poll();
    expect(repeat.reconciliationRequired).toBe(1); expect(calls).toBe(1);
    expect(JSON.stringify(f.ctx.logs)).not.toContain("secret provider outcome");
  });

  test("a lost result save and even failed ambiguity marking leave a pending no-retry boundary", async () => {
    const f = fixture();
    const ledger: OperationLedger = {
      begin: (...args) => f.ledger.begin(...args), get: (...args) => f.ledger.get(...args),
      complete: async () => { throw new Error("disk failed"); }, markAmbiguous: async () => { throw new Error("disk failed"); },
    };
    const first = registerPostHogPolling({ ...f.deps, ledger });
    expect((await first.poll()).reconciliationRequired).toBe(1);
    const restarted = registerPostHogPolling({ ...f.deps, ledger: f.ledger });
    expect((await restarted.poll()).reconciliationRequired).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect((await f.signals.byFingerprint(f.sent[0]!.fingerprint))!.count).toBe(1);
  });

  test("an unavailable or revoked connection stops queued polling without network calls", async () => {
    const disconnected = fixture();
    await disconnected.polling.start(); disconnected.disconnect(); await disconnected.runNext();
    expect(disconnected.requests()).toBe(0); expect(disconnected.ctx.queued).toHaveLength(0);
    const revoked = fixture();
    await revoked.polling.start(); revoked.revoke(); await revoked.runNext();
    expect(revoked.requests()).toBe(0); expect(revoked.ctx.queued).toHaveLength(0);
    expect((await revoked.polling.poll()).status).toBe("inactive");
  });

  test("connection changes or local stop prevent previously queued source work", async () => {
    const f = fixture();
    await f.polling.start(); f.polling.stop(); await f.runNext();
    expect(f.requests()).toBe(0); expect(f.ctx.queued).toHaveLength(0);
    const result = await f.polling.poll({ source: "posthog:43:aaaaaaaaaaaaaaaa" });
    expect(result.status).toBe("inactive");
    await f.polling.start("saved-revision-2");
    expect(f.ctx.queued).toHaveLength(1);
  });

  test("start keys deduplicate within a time bucket and a saved connection revision restarts immediately", async () => {
    const f = fixture();
    await f.polling.start("revision-one"); await f.polling.start("revision-one");
    expect(f.ctx.queued).toHaveLength(1);
    await f.polling.start("revision-two"); expect(f.ctx.queued).toHaveLength(2);
    const keys = f.ctx.queued.map((job) => job.key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(JSON.stringify(f.ctx.queued)).not.toContain("phx_");
  });

  test("rate limits retain the requested window for scheduled retry; permission errors stop scheduling", async () => {
    const limited = fixture(); limited.status(429);
    await limited.polling.start(); await limited.runNext();
    expect(limited.ctx.queued).toHaveLength(1);
    expect(limited.ctx.logs.at(-1)!.fields).toMatchObject({ status: "unavailable", reason: "rate_limited" });
    expect(limited.sent).toHaveLength(0);
    const denied = fixture(); denied.status(403);
    await denied.polling.start(); await denied.runNext();
    expect(denied.ctx.queued).toHaveLength(0); expect(denied.sent).toHaveLength(0);
  });

  test("stale computations and no-data windows never become healthy claims", async () => {
    const stale = fixture(); stale.stale();
    expect(await stale.polling.poll({ since: "2026-11-08T11:00:00Z" })).toMatchObject({
      status: "unavailable", reason: "stale_or_unknown_computation", nextSince: "2026-11-08T11:00:00Z",
    });
    expect(stale.sent).toHaveLength(0);
    const empty = fixture(0);
    const result = await empty.polling.poll();
    expect(result).toMatchObject({ status: "complete", observed: 0, ingested: 0 });
    expect(JSON.stringify(result)).not.toContain("healthy"); expect(empty.sent).toHaveLength(0);
  });

  test("a cached query computed before a short watch cannot be relabelled fresh on retrieval or close the watch", async () => {
    const f = fixture(0);
    const since = "2026-11-08T11:59:00.000Z";
    f.response({ is_cached: true, last_refresh: "2026-11-08T11:56:00.000Z" });
    // Four minutes is accepted for research freshness; it does not cover this one-minute production-watch window.
    expect((await f.source.exceptions(since)).freshness.state).toBe("fresh");
    const watch = await personalWatch(f);
    const trail = { state: "watching", area: "application" } as Trail;
    const coverage = await watch.coverage(trail, since);
    expect(coverage.observedAt).toBe("2026-11-08T11:56:00.000Z");
    expect(coverage.gaps).toContain("PostHog computation has not covered the required watch end.");
    const config = { windowS: 60, fingerprints: ["fixture-original-fingerprint"], touchedFiles: [], routes: [], areaProbes: [],
      baseline: { errorRate: 0 }, startedAt: since };
    const { observations } = await new WatchCollector().collect(config, { signals: f.signals, clock: f.ctx.clock,
      runProbe: async () => "unavailable" });
    observations.coverageGaps.push(...coverage.gaps);
    expect(evaluateWatch(config, observations, "medium")).toMatchObject({ rollback: false, canClose: false });
    f.response({ is_cached: false, last_refresh: NOW });
    const fresh = await watch.coverage(trail, since);
    expect(fresh.gaps).toEqual([]); expect(fresh.observedAt).toBe(NOW);
    observations.coverageGaps = fresh.gaps;
    expect(evaluateWatch(config, observations, "medium")).toMatchObject({ rollback: false, canClose: true });
  });

  test("recent cached computation still cannot close a watch until it covers the full required end", async () => {
    const f = fixture(0);
    const since = "2026-11-08T11:59:00.000Z";
    const watch = await personalWatch(f);
    const trail = { state: "watching", area: "application" } as Trail;
    for (const refresh of ["2026-11-08T11:59:01.000Z", "2026-11-08T11:59:59.500Z"]) {
      f.response({ is_cached: true, last_refresh: refresh });
      const coverage = await watch.coverage(trail, since);
      expect(coverage.observedAt).toBe(refresh);
      expect(coverage.gaps).toContain("PostHog computation has not covered the required watch end.");
    }
  });

  test("terminal truncation and history clamping remain coverage gaps even after all query pages were ingested", async () => {
    const truncated = fixture(1);
    const original = row(1);
    original[3] = [{ type: "TypeError", value: "Cart unavailable", stacktrace: { frames:
      Array.from({ length: 21 }, () => ({ filename: "src/cart.ts", in_app: true })) } }] as never;
    truncated.response({ results: [original] });
    const result = await truncated.polling.poll({ since: "2026-11-08T11:00:00.000Z" });
    expect(result.status).toBe("complete"); // Delivery/pagination finished; coverage is a separate contract.
    expect(result.coverage?.complete).toBe(false);
    expect(result.coverage?.gaps).toContain("Exception evidence was truncated.");
    const clamped = fixture(0);
    const old = await clamped.polling.poll({ since: "2026-10-01T00:00:00.000Z" });
    expect(old.status).toBe("complete"); expect(old.coverage?.complete).toBe(false);
    expect(old.coverage?.gaps).toContain("Requested query history was clamped.");
    const uncached = fixture(0); uncached.response({ is_cached: false, last_refresh: null });
    expect((await uncached.polling.poll()).coverage).toMatchObject({ complete: true,
      computedThrough: NOW.replace(".000Z", ".000000Z"), computation: "uncached_query_window" });
  });

  test("revocation after storage blocks triage and conservatively marks the event ambiguous", async () => {
    const f = fixture();
    const upsert = f.signals.upsert.bind(f.signals);
    f.signals.upsert = async (signal) => { const result = await upsert(signal); f.revoke(); return result; };
    expect((await f.polling.poll()).reconciliationRequired).toBe(1);
    expect(f.sent).toHaveLength(0);
    expect((await f.polling.poll()).status).toBe("inactive");
  });
});
