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
