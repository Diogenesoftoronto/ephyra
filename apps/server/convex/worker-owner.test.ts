import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./runtime.ts": () => import("./runtime"),
  "./runs.ts": () => import("./runs"),
};
const auth = { secret: "worker-fixture-credential-".repeat(2), workspace: "owner-test" };
let prior: string | undefined;
beforeEach(() => { prior = process.env.EPHYRA_CONVEX_SECRET; process.env.EPHYRA_CONVEX_SECRET = auth.secret; });
afterEach(() => {
  if (prior === undefined) delete process.env.EPHYRA_CONVEX_SECRET;
  else process.env.EPHYRA_CONVEX_SECRET = prior;
});
const fixture = () => convexTest(schema, modules);
type Fixture = ReturnType<typeof fixture>;
async function register(t: Fixture, ownerId: string) {
  const receipt = await t.mutation(api.runtime.registerWorker, { ...auth, ownerId, ttlMs: 30000 });
  return { ...auth, ownerId, fence: receipt.fence };
}
const run = (id = "run-one", status = "running") => JSON.stringify({
  id, trailId: null, short: null, step: "patch", persona: "bell", engine: "fixture", executor: { kind: "local" },
  status, startedAt: "2026-11-07T10:00:00.000Z",
});
const event = JSON.stringify({ at: "2026-11-07T10:00:00.000Z", type: "message", text: "actual fixture event" });
const job = (key: string) => ({ ...auth, key, kind: "agent_step", payload: "{}", runAtMs: 0 });
async function expire(t: Fixture) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("runtimeWorkers").withIndex("by_workspace", (q) => q.eq("workspace", auth.workspace)).unique();
    await ctx.db.patch(row!._id, { expiresMs: 0 });
  });
}

test("overlapping boot cannot steal a live workspace's jobs or close its transcripts", async () => {
  const t = convexTest(schema, modules), a = await register(t, "worker-a-one");
  await t.mutation(api.runtime.enqueue, job("patch-one"));
  const [claim] = await t.mutation(api.runtime.claim, { ...a, nowMs: 1, limit: 1 });
  await t.mutation(api.runs.create, { ...a, runId: "run-one", json: run() });
  const b = await register(t, "worker-b-two");
  expect(await t.mutation(api.runtime.claim, { ...b, nowMs: 1, limit: 1 })).toEqual([]);
  expect(await t.mutation(api.runtime.recoverRunning, b)).toBe(0);
  expect(await t.mutation(api.runs.closeRunning, { ...b, reason: "other replica boot", endedAt: "2026-11-07T11:00:00Z" })).toBe(0);
  expect(await t.mutation(api.runtime.recoverRunning, a)).toBe(0);
  expect(await t.mutation(api.runs.closeRunning, { ...a, reason: "same owner", endedAt: "2026-11-07T11:00:00Z" })).toBe(0);
  // Rolling old binaries may read and enqueue, but cannot claim or finish work without a fence.
  expect(await t.mutation(api.runtime.claim, { ...auth, nowMs: 1, limit: 1 })).toEqual([]);
  expect(await t.mutation(api.runtime.recoverRunning, auth)).toBe(0);
  expect(await t.mutation(api.runtime.finish, { ...auth, key: "patch-one" })).toBe(false);
  expect(await t.mutation(api.runtime.finish, { ...b, key: "patch-one", claimId: claim!.claimId })).toBe(false);
  expect((await t.query(api.runtime.activeJobs, auth))[0]!.status).toBe("running");
  expect(JSON.parse((await t.query(api.runs.get, { ...auth, runId: "run-one" }))!).status).toBe("running");
});

test("expired owner is fenced; takeover quarantines uncertain work and only claims untouched queued work", async () => {
  const t = convexTest(schema, modules), a = await register(t, "worker-a-one");
  await t.mutation(api.runtime.enqueue, job("uncertain"));
  const [old] = await t.mutation(api.runtime.claim, { ...a, nowMs: 1, limit: 1 });
  await t.mutation(api.runs.create, { ...a, runId: "run-one", json: run() });
  await t.mutation(api.runtime.enqueue, job("safe-queued"));
  await expire(t);
  expect((await t.mutation(api.runtime.heartbeatWorker, { ...a, ttlMs: 30000 })).active).toBe(false);
  expect(await t.mutation(api.runtime.claim, { ...a, nowMs: Number.MAX_SAFE_INTEGER, limit: 10 })).toEqual([]);
  expect(await t.mutation(api.runtime.finish, { ...a, key: "uncertain", claimId: old!.claimId })).toBe(false);
  expect(await t.mutation(api.runtime.fail, { ...a, key: "uncertain", claimId: old!.claimId, error: "late", runAtMs: 0, dead: false })).toBe(false);
  const b = await register(t, "worker-b-two");
  expect(b.fence).toBe(a.fence + 1);
  expect(await t.mutation(api.runtime.releaseWorker, a)).toBe(false);
  expect(await t.mutation(api.runtime.recoverRunning, b)).toBe(1);
  expect(await t.mutation(api.runs.closeRunning, { ...b, reason: "Previous owner ended; reconcile external outcome", endedAt: "2026-11-07T11:00:00Z" })).toBe(1);
  const dead = await t.query(api.runtime.deadJobs, auth);
  expect(dead).toHaveLength(1);
  expect(dead[0]!.key).toBe("uncertain");
  expect(dead[0]!.error).toContain("reconciliation");
  expect(await t.mutation(api.runs.update, { ...a, runId: "run-one", json: run("run-one", "done") })).toBe(false);
  expect(await t.mutation(api.runs.update, { ...b, runId: "run-one", json: run("run-one", "done") })).toBe(false);
  await expect(t.mutation(api.runs.appendEvents, { ...a, runId: "run-one", events: [event] })).rejects.toThrow("lease");
  await expect(t.mutation(api.runs.appendEvents, { ...b, runId: "run-one", events: [event] })).rejects.toThrow("previous worker");
  await expect(t.mutation(api.runtime.putTrail, { ...a, trailId: "trail", state: "proved", json: "late" })).rejects.toThrow("lease");
  await expect(t.mutation(api.runtime.recordEvent, { ...auth, trailId: "trail", eventId: "late", json: "late" })).rejects.toThrow("lease");
  const claims = await t.mutation(api.runtime.claim, { ...b, nowMs: 1, limit: 10 });
  expect(claims.map((j) => [j.key, j.attempts])).toEqual([["safe-queued", 1]]);
  expect(await t.mutation(api.runtime.finish, { ...b, key: "safe-queued", claimId: claims[0]!.claimId })).toBe(true);
  expect(await t.mutation(api.runtime.recoverRunning, b)).toBe(0);
});

test("a previous attempt cannot complete a retried job within the same live ownership", async () => {
  const t = convexTest(schema, modules), owner = await register(t, "worker-a-one");
  await t.mutation(api.runtime.enqueue, job("retry"));
  const [first] = await t.mutation(api.runtime.claim, { ...owner, nowMs: 1, limit: 1 });
  await t.mutation(api.runtime.fail, { ...owner, key: "retry", claimId: first!.claimId, error: "safe local failure", runAtMs: 0, dead: false });
  const [second] = await t.mutation(api.runtime.claim, { ...owner, nowMs: 1, limit: 1 });
  expect(first!.claimId).not.toBe(second!.claimId);
  expect(await t.mutation(api.runtime.finish, { ...owner, key: "retry", claimId: first!.claimId })).toBe(false);
  expect(await t.mutation(api.runtime.finish, { ...owner, key: "retry", claimId: second!.claimId })).toBe(true);
  expect(await t.mutation(api.runtime.finish, { ...owner, key: "retry", claimId: second!.claimId })).toBe(true);
});

test("legacy running rows require reconciliation; a new owner never auto-retries them", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("jobs", { workspace: auth.workspace, key: "legacy", kind: "agent_step", payload: "{}", status: "running", runAtMs: 0, attempts: 1 });
    await ctx.db.insert("runs", { workspace: auth.workspace, runId: "run-one", status: "running", startedMs: 0, json: run() });
  });
  const owner = await register(t, "worker-a-one");
  expect(await t.mutation(api.runtime.recoverRunning, owner)).toBe(1);
  expect(await t.mutation(api.runs.closeRunning, { ...owner, reason: "legacy owner unavailable", endedAt: "2026-11-07T11:00:00Z" })).toBe(1);
  expect(await t.mutation(api.runtime.claim, { ...owner, nowMs: 1, limit: 1 })).toEqual([]);
});
