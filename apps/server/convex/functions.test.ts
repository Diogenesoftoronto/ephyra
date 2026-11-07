// In-process tests of the Convex functions (convex-test under bun test, as in notorganic-provider).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { canonicalJson } from "./lib";
import { createHash } from "node:crypto";

const modules = {
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./signals.ts": () => import("./signals"),
  "./runtime.ts": () => import("./runtime"),
  "./ledger.ts": () => import("./ledger"),
  "./usage.ts": () => import("./usage"),
  "./drafts.ts": () => import("./drafts"),
  "./runs.ts": () => import("./runs"),
  "./audit.ts": () => import("./audit"),
};
const secret = "s".repeat(40);
let prior: string | undefined;
beforeEach(() => { prior = process.env.EPHYRA_CONVEX_SECRET; process.env.EPHYRA_CONVEX_SECRET = secret; });
afterEach(() => { if (prior === undefined) delete process.env.EPHYRA_CONVEX_SECRET; else process.env.EPHYRA_CONVEX_SECRET = prior; });

const signal = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: crypto.randomUUID(), fingerprint: "v1:abc", count: 1, firstSeen: "2026-11-07T00:00:00.000Z",
  lastSeen: "2026-11-07T00:00:00.000Z", ...over,
});

describe("auth", () => {
  test("wrong or missing secret is rejected", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.runtime.inboxList, { secret: "x".repeat(40) })).rejects.toThrow("unauthorized");
    delete process.env.EPHYRA_CONVEX_SECRET;
    await expect(t.query(api.runtime.inboxList, { secret })).rejects.toThrow("not configured");
  });
});

describe("signals", () => {
  test("upsert merges by fingerprint and counts occurrences", async () => {
    const t = convexTest(schema, modules);
    const a = await t.mutation(api.signals.upsert, { secret, json: signal(), topInAppFile: "src/cart.ts" });
    const b = await t.mutation(api.signals.upsert, { secret, json: signal({ count: 2, lastSeen: "2026-11-07T00:05:00.000Z" }) });
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(JSON.parse(b.json).count).toBe(3);
    expect(await t.query(api.signals.countSince, { secret, fingerprint: "v1:abc", sinceMs: Date.parse("2026-11-07T00:01:00Z") })).toBe(2);
    const inFiles = await t.query(api.signals.newInFiles, { secret, files: ["src/cart.ts"], sinceMs: 0 });
    expect(inFiles.length).toBe(1);
  });
  test("error rate sums minute buckets; mutes expire", async () => {
    const t = convexTest(schema, modules);
    const at = Date.parse("2026-11-07T01:00:10Z");
    await t.mutation(api.signals.recordRequest, { secret, route: "/cart", atMs: at, error: false });
    await t.mutation(api.signals.recordRequest, { secret, route: "/cart", atMs: at + 1000, error: true });
    expect(await t.query(api.signals.errorRate, { secret, route: "/cart", fromMs: at - 60_000, toMs: at + 60_000 }))
      .toEqual({ requests: 2, errors: 1 });
    await t.mutation(api.signals.mute, { secret, fingerprint: "v1:abc", untilMs: 1000 });
    expect(await t.query(api.signals.isMuted, { secret, fingerprint: "v1:abc", atMs: 500 })).toBe(true);
    expect(await t.query(api.signals.isMuted, { secret, fingerprint: "v1:abc", atMs: 1500 })).toBe(false);
  });
});

describe("runtime", () => {
  test("events dedupe by id and keep order", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.runtime.recordEvent, { secret, eventId: "e1", trailId: "t", json: "1" })).toBe(true);
    expect(await t.mutation(api.runtime.recordEvent, { secret, eventId: "e1", trailId: "t", json: "1" })).toBe(false);
    await t.mutation(api.runtime.recordEvent, { secret, eventId: "e2", trailId: "t", json: "2" });
    expect(await t.query(api.runtime.events, { secret, trailId: "t" })).toEqual(["1", "2"]);
  });
  test("jobs: enqueue is idempotent, claim is exclusive, failures retry then dead-letter", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(api.runtime.enqueue, { secret, key: "k", kind: "triage", payload: "{}", runAtMs: 0 })).toBe(true);
    expect(await t.mutation(api.runtime.enqueue, { secret, key: "k", kind: "triage", payload: "{}", runAtMs: 0 })).toBe(false);
    const first = await t.mutation(api.runtime.claim, { secret, nowMs: 10, limit: 5 });
    expect(first.map((j) => j.key)).toEqual(["k"]);
    expect(await t.mutation(api.runtime.claim, { secret, nowMs: 10, limit: 5 })).toEqual([]);
    await t.mutation(api.runtime.fail, { secret, key: "k", error: "boom", runAtMs: 20, dead: false });
    expect(await t.mutation(api.runtime.claim, { secret, nowMs: 15, limit: 5 })).toEqual([]);
    expect((await t.mutation(api.runtime.claim, { secret, nowMs: 25, limit: 5 }))[0]?.attempts).toBe(2);
    await t.mutation(api.runtime.fail, { secret, key: "k", error: "boom", runAtMs: 30, dead: true });
    expect(await t.query(api.runtime.deadJobs, { secret })).toEqual([{ key: "k", kind: "triage", error: "boom" }]);
  });
});

describe("ledger", () => {
  test("begin is fresh once; same key with another plan is refused", async () => {
    const t = convexTest(schema, modules);
    expect((await t.mutation(api.ledger.begin, { secret, key: "op", planDigest: "d1", at: "now" })).fresh).toBe(true);
    const again = await t.mutation(api.ledger.begin, { secret, key: "op", planDigest: "d1", at: "now" });
    expect(again.fresh).toBe(false);
    expect(again.record?.status).toBe("pending");
    await expect(t.mutation(api.ledger.begin, { secret, key: "op", planDigest: "d2", at: "now" })).rejects.toThrow("reused");
    await t.mutation(api.ledger.complete, { secret, key: "op", result: "null" });
    expect((await t.query(api.ledger.get, { secret, key: "op" }))?.status).toBe("done");
  });
});

describe("audit", () => {
  test("chain links and hashes match the server's canonical hashing", async () => {
    const t = convexTest(schema, modules);
    const inputs = [1, 2, 3].map((n) => ({ id: `a${n}`, at: "t", principal: "p", action: "decide", target: "x", detail: { n } }));
    for (const input of inputs) await t.mutation(api.audit.append, { secret, json: JSON.stringify(input) });
    const rows = await t.query(api.audit.list, { secret });
    let prev = "";
    rows.forEach((row, i) => {
      expect(row.prevHash).toBe(prev);
      expect(row.hash).toBe(createHash("sha256").update(prev).update(canonicalJson(inputs[i])).digest("hex"));
      prev = row.hash;
    });
    await expect(t.mutation(api.audit.append, { secret, json: JSON.stringify(inputs[0]) })).rejects.toThrow("reused");
  });
});

test("usage records are secret-gated and idempotent", async () => {
  const t = convexTest(schema, modules);
  const json = JSON.stringify({ id: "1", idempotencyKey: "k", at: "2026-11-07T00:00:00.000Z", kind: "draft",
    persona: "velum", step: "draft", engine: "fake", trailId: null, short: null, tokens: null,
    costMicrousd: null, wallMs: null, outcome: "ok", billedTo: "unknown" });
  await expect(t.mutation(api.usage.record, { secret: "wrong", key: "k", json })).rejects.toThrow();
  await t.mutation(api.usage.record, { secret, key: "k", json });
  await t.mutation(api.usage.record, { secret, key: "k", json });
  expect(await t.query(api.usage.list, { secret })).toEqual([json]);
});

const draft = (over: Record<string, unknown> = {}) => ({
  id: "d-1", path: "autonomy.md", kind: "autonomy", baseDigest: "abc", content: "## defaults\n", warnings: [], status: "open", createdBy: "me",
  createdAt: "2026-11-07T10:00:00.000Z", updatedAt: "2026-11-07T10:00:00.000Z", messages: [], ...over,
});

describe("drafts", () => {
  test("secret-gated; put upserts by id and validates the shape; list is newest first and filters by status", async () => {
    const t = convexTest(schema, modules);
    const a = JSON.stringify(draft());
    await expect(t.mutation(api.drafts.put, { secret: "x".repeat(40), draftId: "d-1", json: a })).rejects.toThrow("unauthorized");
    await expect(t.query(api.drafts.get, { secret: "x".repeat(40), draftId: "d-1" })).rejects.toThrow("unauthorized");
    await expect(t.query(api.drafts.list, { secret: "x" })).rejects.toThrow();
    await t.mutation(api.drafts.put, { secret, draftId: "d-1", json: a });
    const b = JSON.stringify(draft({ id: "d-2", updatedAt: "2026-11-07T11:00:00.000Z" }));
    await t.mutation(api.drafts.put, { secret, draftId: "d-2", json: b });
    expect(await t.query(api.drafts.get, { secret, draftId: "d-1" })).toBe(a);
    expect(await t.query(api.drafts.get, { secret, draftId: "nope" })).toBeNull();
    expect(await t.query(api.drafts.list, { secret })).toEqual([b, a]);
    const published = JSON.stringify(draft({ status: "published", updatedAt: "2026-11-07T12:00:00.000Z",
      published: { ref: "refs/ephyra/policy/d-1", commit: "c".repeat(40), by: "me", at: "2026-11-07T12:00:00.000Z" } }));
    await t.mutation(api.drafts.put, { secret, draftId: "d-1", json: published });
    expect(await t.query(api.drafts.list, { secret, status: "published" })).toEqual([published]);
    expect(await t.query(api.drafts.list, { secret, status: "open" })).toEqual([b]);
    expect((await t.query(api.drafts.list, { secret })).length).toBe(2);
    await expect(t.mutation(api.drafts.put, { secret, draftId: "other", json: a })).rejects.toThrow("mismatch");
    await expect(t.mutation(api.drafts.put, { secret, draftId: "d-3", json: JSON.stringify({ id: "d-3" }) })).rejects.toThrow();
  });
});

const run = (over: Record<string, unknown> = {}) => ({
  id: "r1", trailId: "01a1b539-866f-77a3-833f-b417d7707bbd", short: "T-07bbd0", step: "research", persona: "bell", engine: "amp/medium",
  executor: { kind: "orb" }, status: "running", startedAt: "2026-11-07T10:00:00.000Z", ...over,
});
const ev = (text: string) => JSON.stringify({ at: "2026-11-07T10:00:00.000Z", type: "message", text });

describe("runs", () => {
  test("secret-gated; create is idempotent; update changes status; list orders and filters", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.runs.create, { secret: "x".repeat(40), runId: "r1", json: JSON.stringify(run()) })).rejects.toThrow("unauthorized");
    expect(await t.mutation(api.runs.create, { secret, runId: "r1", json: JSON.stringify(run()) })).toBe(true);
    expect(await t.mutation(api.runs.create, { secret, runId: "r1", json: JSON.stringify(run({ status: "failed" })) })).toBe(false);
    await t.mutation(api.runs.create, { secret, runId: "r2", json: JSON.stringify(run({ id: "r2", trailId: null, short: null, startedAt: "2026-11-07T11:00:00.000Z" })) });
    expect((await t.query(api.runs.list, { secret, limit: 10 })).map((j) => JSON.parse(j).id)).toEqual(["r2", "r1"]);
    expect((await t.query(api.runs.list, { secret, limit: 10, trailId: "01a1b539-866f-77a3-833f-b417d7707bbd" })).map((j) => JSON.parse(j).id)).toEqual(["r1"]);
    const done = JSON.stringify(run({ status: "done", endedAt: "2026-11-07T10:05:00.000Z" }));
    expect(await t.mutation(api.runs.update, { secret, runId: "r1", json: done })).toBe(true);
    expect(await t.mutation(api.runs.update, { secret, runId: "zzz", json: JSON.stringify(run({ id: "zzz" })) })).toBe(false);
    expect(await t.query(api.runs.get, { secret, runId: "r1" })).toBe(done);
    expect((await t.query(api.runs.list, { secret, limit: 10, status: "running" })).map((j) => JSON.parse(j).id)).toEqual(["r2"]);
    await expect(t.mutation(api.runs.create, { secret, runId: "bad", json: JSON.stringify({ id: "bad" }) })).rejects.toThrow();
  });
  test("events get gap-free seq per run inside the mutation; after resumes; unknown runs and oversized batches are refused", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.runs.create, { secret, runId: "r1", json: JSON.stringify(run()) });
    await t.mutation(api.runs.create, { secret, runId: "r2", json: JSON.stringify(run({ id: "r2" })) });
    expect(await t.mutation(api.runs.appendEvents, { secret, runId: "r1", events: [ev("a"), ev("b")] })).toBe(0);
    expect(await t.mutation(api.runs.appendEvents, { secret, runId: "r2", events: [ev("x")] })).toBe(0);
    expect(await t.mutation(api.runs.appendEvents, { secret, runId: "r1", events: [ev("c")] })).toBe(2);
    const all = (await t.query(api.runs.events, { secret, runId: "r1", limit: 100 })).map((j) => JSON.parse(j));
    expect(all.map((e) => [e.seq, e.text, e.runId])).toEqual([[0, "a", "r1"], [1, "b", "r1"], [2, "c", "r1"]]);
    expect((await t.query(api.runs.events, { secret, runId: "r1", after: 0, limit: 100 })).map((j) => JSON.parse(j).seq)).toEqual([1, 2]);
    expect((await t.query(api.runs.events, { secret, runId: "r1", after: 2, limit: 100 }))).toEqual([]);
    expect((await t.query(api.runs.events, { secret, runId: "r1", limit: 2 })).length).toBe(2);
    await expect(t.mutation(api.runs.appendEvents, { secret, runId: "nope", events: [ev("a")] })).rejects.toThrow("unknown run");
    await expect(t.mutation(api.runs.appendEvents, { secret, runId: "r1", events: Array.from({ length: 101 }, () => ev("x")) })).rejects.toThrow("too many");
    await expect(t.mutation(api.runs.appendEvents, { secret, runId: "r1", events: [JSON.stringify({ type: "message", text: "x".repeat(20001), at: "2026-11-07T10:00:00.000Z" })] })).rejects.toThrow();
    // A rejected batch leaves no partial events behind.
    expect((await t.query(api.runs.events, { secret, runId: "r1", limit: 100 })).length).toBe(3);
  });
  test("closeRunning fails runs left running by a crashed server", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.runs.create, { secret, runId: "r1", json: JSON.stringify(run()) });
    await t.mutation(api.runs.create, { secret, runId: "r2", json: JSON.stringify(run({ id: "r2", status: "done" })) });
    expect(await t.mutation(api.runs.closeRunning, { secret, reason: "restart", endedAt: "2026-11-07T12:00:00.000Z" })).toBe(1);
    expect(JSON.parse((await t.query(api.runs.get, { secret, runId: "r1" }))!)).toMatchObject({ status: "failed", error: "restart", endedAt: "2026-11-07T12:00:00.000Z" });
    expect(JSON.parse((await t.query(api.runs.get, { secret, runId: "r2" }))!).status).toBe("done");
  });
});

test("activeJobs lists queued and running jobs with the claim time", async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.runtime.activeJobs, { secret: "x".repeat(40) })).rejects.toThrow("unauthorized");
  await t.mutation(api.runtime.enqueue, { secret, key: "a", kind: "agent_step", payload: "{}", runAtMs: 0 });
  await t.mutation(api.runtime.enqueue, { secret, key: "b", kind: "proof", payload: "{}", runAtMs: 99_999 });
  await t.mutation(api.runtime.claim, { secret, nowMs: 1234, limit: 1 });
  const jobs = await t.query(api.runtime.activeJobs, { secret });
  expect(jobs.map((j) => [j.key, j.status, j.startedMs])).toEqual([["a", "running", 1234], ["b", "queued", null]]);
  await t.mutation(api.runtime.finish, { secret, key: "a" });
  expect((await t.query(api.runtime.activeJobs, { secret })).map((j) => j.key)).toEqual(["b"]);
});
