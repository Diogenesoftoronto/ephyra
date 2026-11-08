import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { scopedConvexClient } from "../src/convex/stores";
import { api } from "./_generated/api";
import schema from "./schema";

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
const scopes = ["workspace-a", "workspace-b", undefined] as const;
const scoped = (workspace: string | undefined) => (workspace === undefined ? { secret } : { secret, workspace });
const label = (workspace: string | undefined) => workspace ?? "legacy";
type TestStore = ReturnType<typeof convexTest>;
const workers = new WeakMap<TestStore, Map<string | undefined, { secret: string; workspace?: string; ownerId: string; fence: number }>>();
async function owned(t: TestStore, workspace: string | undefined) {
  const owners = workers.get(t) ?? new Map();
  workers.set(t, owners);
  if (!owners.has(workspace)) {
    const ownerId = crypto.randomUUID();
    const result = await t.mutation(api.runtime.registerWorker, { ...scoped(workspace), ownerId, ttlMs: 30000 });
    owners.set(workspace, { ...scoped(workspace), ownerId, fence: result.fence });
  }
  return owners.get(workspace)!;
}
async function successor(t: TestStore, workspace: string | undefined) {
  await t.mutation(api.runtime.releaseWorker, await owned(t, workspace));
  workers.get(t)!.delete(workspace);
  return owned(t, workspace);
}

const trailId = "01a1b539-866f-77a3-833f-b417d7707bbd";
const at = "2026-11-07T10:00:00.000Z";
const later = "2026-11-07T11:00:00.000Z";
const parse = (json: string | null) => (json === null ? null : JSON.parse(json));
let priorSecret: string | undefined;

beforeEach(() => {
  priorSecret = process.env.EPHYRA_CONVEX_SECRET;
  process.env.EPHYRA_CONVEX_SECRET = secret;
});
afterEach(() => {
  if (priorSecret === undefined) delete process.env.EPHYRA_CONVEX_SECRET;
  else process.env.EPHYRA_CONVEX_SECRET = priorSecret;
});

const run = (workspace: string | undefined, extra: Record<string, unknown> = {}) => ({
  id: "same-run",
  trailId,
  short: "T-07bbd0",
  step: "research",
  persona: "bell",
  engine: label(workspace),
  executor: { kind: "orb" },
  status: "running",
  startedAt: workspace === "workspace-a" ? at : later,
  ...extra,
});
const draft = (workspace: string | undefined, extra: Record<string, unknown> = {}) => ({
  id: "same-draft",
  path: "autonomy.md",
  kind: "autonomy",
  baseDigest: "abc",
  content: label(workspace),
  warnings: [],
  status: "open",
  createdBy: label(workspace),
  createdAt: at,
  updatedAt: workspace === "workspace-a" ? at : later,
  messages: [],
  ...extra,
});
const event = (text: string) => JSON.stringify({ at, type: "message", text });

describe("workspace persistence isolation", () => {
  test("identical trails, events and inbox IDs coexist; updates and removals stay in their workspace", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const args = scoped(workspace);
      const json = JSON.stringify({ owner: label(workspace) });
      // Before its own write, even the legacy namespace cannot see previously inserted namespaced rows.
      expect(await t.query(api.runtime.getTrail, { ...args, trailId })).toBeNull();
      expect(await t.query(api.runtime.inboxGet, { ...args, itemId: "same-inbox" })).toBeNull();
      await t.mutation(api.runtime.putTrail, { ...await owned(t, workspace), trailId, state: "hypothesised", json });
      expect(await t.mutation(api.runtime.recordEvent, { ...await owned(t, workspace), eventId: "same-event", trailId, json })).toBe(true);
      expect(await t.mutation(api.runtime.recordEvent, { ...await owned(t, workspace), eventId: "same-event", trailId, json })).toBe(false);
      await t.mutation(api.runtime.inboxPut, { ...await owned(t, workspace), itemId: "same-inbox", trailId, json });
    }
    await t.mutation(api.runtime.putTrail, {
      ...await owned(t, "workspace-a"),
      trailId,
      state: "patched",
      json: JSON.stringify({ owner: "updated-a" }),
    });
    await t.mutation(api.runtime.inboxRemove, { ...await owned(t, "workspace-a"), itemId: "same-inbox" });
    for (const workspace of scopes) {
      const args = scoped(workspace);
      const expected = workspace === "workspace-a" ? "updated-a" : label(workspace);
      expect(parse(await t.query(api.runtime.getTrail, { ...args, trailId }))).toEqual({ owner: expected });
      expect((await t.query(api.runtime.listTrails, args)).map(parse)).toEqual([{ owner: expected }]);
      expect((await t.query(api.runtime.listTrails, { ...args, states: ["hypothesised"] })).map(parse)).toEqual(
        workspace === "workspace-a" ? [] : [{ owner: label(workspace) }],
      );
      expect((await t.query(api.runtime.events, { ...args, trailId })).map(parse)).toEqual([
        { owner: label(workspace) },
      ]);
      expect((await t.query(api.runtime.inboxList, args)).map(parse)).toEqual(
        workspace === "workspace-a" ? [] : [{ owner: label(workspace) }],
      );
    }
    expect(await t.query(api.runtime.listTrails, scoped("empty"))).toEqual([]);
  });

  test("job claims, recovery, completion and failure cannot affect the same key in another workspace", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const args = { ...scoped(workspace), key: "same-job", kind: "triage", payload: label(workspace), runAtMs: 0 };
      expect(await t.mutation(api.runtime.enqueue, args)).toBe(true);
      expect(await t.mutation(api.runtime.enqueue, args)).toBe(false);
    }
    expect(await t.mutation(api.runtime.claim, { ...await owned(t, "empty"), nowMs: 10, limit: 1 })).toEqual([]);
    const claims = new Map<string | undefined, string>();
    for (const workspace of scopes) {
      const claimed = await t.mutation(api.runtime.claim, { ...await owned(t, workspace), nowMs: 10, limit: 1 });
      expect(claimed.map((job) => [job.key, job.payload, job.attempts])).toEqual([["same-job", label(workspace), 1]]);
      claims.set(workspace, claimed[0]!.claimId);
    }
    // Booting/recovering without an ownership change cannot close a live worker's jobs.
    expect(await t.mutation(api.runtime.recoverRunning, await owned(t, "workspace-a"))).toBe(0);
    for (const workspace of scopes) {
      expect((await t.query(api.runtime.activeJobs, scoped(workspace))).map((job) => job.status)).toEqual(["running"]);
    }
    await t.mutation(api.runtime.finish, { ...await owned(t, "workspace-a"), key: "same-job", claimId: claims.get("workspace-a")! });
    await t.mutation(api.runtime.fail, {
      ...await owned(t, "workspace-b"), key: "same-job", claimId: claims.get("workspace-b")!,
      error: "b failed", runAtMs: 20, dead: true,
    });
    expect(await t.query(api.runtime.activeJobs, scoped("workspace-a"))).toEqual([]);
    expect(await t.query(api.runtime.deadJobs, scoped("workspace-a"))).toEqual([]);
    expect(await t.query(api.runtime.deadJobs, scoped("workspace-b"))).toEqual([
      { key: "same-job", kind: "triage", error: "b failed" },
    ]);
    expect((await t.query(api.runtime.activeJobs, scoped(undefined))).map((job) => job.status)).toEqual(["running"]);
    expect(await t.query(api.runtime.deadJobs, scoped(undefined))).toEqual([]);
    await successor(t, undefined);
    expect(await t.mutation(api.runtime.recoverRunning, await owned(t, undefined))).toBe(1);
    expect(await t.mutation(api.runtime.recoverRunning, await owned(t, "workspace-b"))).toBe(0);
    expect((await t.query(api.runtime.deadJobs, scoped(undefined)))[0]!.error).toContain("reconciliation");
  });

  test("fingerprints, occurrences, request baselines and mutes belong to their workspace", async () => {
    const t = convexTest(schema, modules);
    for (const [index, workspace] of scopes.entries()) {
      const args = scoped(workspace);
      expect(await t.query(api.signals.get, { ...args, signalId: "same-signal" })).toBeNull();
      const signal = {
        id: "same-signal",
        fingerprint: "v1:shared",
        count: index + 1,
        firstSeen: at,
        lastSeen: at,
        owner: label(workspace),
      };
      expect(
        (await t.mutation(api.signals.upsert, { ...args, json: JSON.stringify(signal), topInAppFile: "src/app.ts" }))
          .isNew,
      ).toBe(true);
      for (let request = 0; request <= index; request++) {
        await t.mutation(api.signals.recordRequest, {
          ...args,
          route: "/checkout",
          atMs: Date.parse(at),
          error: workspace === "workspace-a",
        });
      }
    }
    await t.mutation(api.signals.upsert, {
      ...scoped("workspace-a"),
      topInAppFile: "src/app.ts",
      json: JSON.stringify({
        id: "new-occurrence",
        fingerprint: "v1:shared",
        count: 5,
        firstSeen: at,
        lastSeen: later,
      }),
    });
    await t.mutation(api.signals.mute, { ...scoped("workspace-a"), fingerprint: "v1:shared", untilMs: 100 });
    for (const [index, workspace] of scopes.entries()) {
      const args = scoped(workspace);
      const count = workspace === "workspace-a" ? 6 : index + 1;
      expect(parse(await t.query(api.signals.get, { ...args, signalId: "same-signal" }))).toMatchObject({
        owner: label(workspace),
        count,
      });
      expect(parse(await t.query(api.signals.byFingerprint, { ...args, fingerprint: "v1:shared" }))).toMatchObject({
        owner: label(workspace),
        count,
      });
      expect(await t.query(api.signals.countSince, { ...args, fingerprint: "v1:shared", sinceMs: 0 })).toBe(count);
      expect(
        (await t.query(api.signals.newInFiles, { ...args, files: ["src/app.ts"], sinceMs: 0 })).map(parse),
      ).toEqual([expect.objectContaining({ owner: label(workspace), count })]);
      expect(
        await t.query(api.signals.errorRate, {
          ...args,
          route: "/checkout",
          fromMs: Date.parse(at),
          toMs: Date.parse(later),
        }),
      ).toEqual({ requests: index + 1, errors: workspace === "workspace-a" ? 1 : 0 });
      expect(await t.query(api.signals.isMuted, { ...args, fingerprint: "v1:shared", atMs: 50 })).toBe(
        workspace === "workspace-a",
      );
    }
    expect(
      await t.query(api.signals.errorRate, {
        ...scoped("empty"),
        route: "/checkout",
        fromMs: 0,
        toMs: Date.parse(later),
      }),
    ).toBeNull();
  });

  test("operation and reconciliation keys can be reused independently without sharing state", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const args = scoped(workspace);
      expect(
        await t.mutation(api.ledger.begin, { ...args, key: "same-effect", planDigest: label(workspace), at }),
      ).toEqual({ fresh: true, record: null });
      await t.mutation(api.ledger.recordReconciliation, { ...args, key: "same-effect", note: label(workspace), at });
    }
    await t.mutation(api.ledger.complete, { ...scoped("workspace-a"), key: "same-effect", result: "a-result" });
    await t.mutation(api.ledger.markAmbiguous, { ...scoped("workspace-b"), key: "same-effect", note: "b-unknown" });
    for (const workspace of scopes) {
      const args = scoped(workspace);
      const expectedStatus =
        workspace === "workspace-a" ? "done" : workspace === "workspace-b" ? "reconciliation_required" : "pending";
      const state = await t.query(api.ledger.get, { ...args, key: "same-effect" });
      expect(state).toMatchObject({ planDigest: label(workspace), status: expectedStatus });
      expect(
        (await t.mutation(api.ledger.begin, { ...args, key: "same-effect", planDigest: label(workspace), at })).fresh,
      ).toBe(false);
      expect(await t.query(api.ledger.reconciliations, args)).toEqual([
        { key: "same-effect", note: label(workspace), at },
      ]);
    }
    expect(await t.query(api.ledger.get, { ...scoped("empty"), key: "same-effect" })).toBeNull();
    await expect(
      t.mutation(api.ledger.complete, { ...scoped("empty"), key: "same-effect", result: "wrong" }),
    ).rejects.toThrow("operation is not pending");
  });

  test("audit ID uniqueness and hash chains are independent, including the legacy chain", async () => {
    const t = convexTest(schema, modules);
    const hashes = new Map<string | undefined, string>();
    for (const workspace of scopes) {
      const json = JSON.stringify({
        id: "same-audit",
        at,
        principal: "operator",
        action: "decide",
        target: label(workspace),
        detail: {},
      });
      const result = await t.mutation(api.audit.append, { ...scoped(workspace), json });
      expect(result.prevHash).toBe("");
      hashes.set(workspace, result.hash);
      await expect(t.mutation(api.audit.append, { ...scoped(workspace), json })).rejects.toThrow("audit id reused");
    }
    for (const workspace of scopes) {
      const json = JSON.stringify({
        id: "same-next",
        at: later,
        principal: "operator",
        action: "apply",
        target: label(workspace),
        detail: {},
      });
      const result = await t.mutation(api.audit.append, { ...scoped(workspace), json });
      expect(result.prevHash).toBe(hashes.get(workspace)!);
      const rows = await t.query(api.audit.list, { ...scoped(workspace), limit: 1 });
      expect(rows).toHaveLength(1);
      expect(parse(rows[0]!.json).target).toBe(label(workspace));
      expect(rows[0]!.prevHash).toBe("");
      expect((await t.query(api.audit.list, scoped(workspace))).map((row) => parse(row.json).target)).toEqual([
        label(workspace),
        label(workspace),
      ]);
    }
    expect(await t.query(api.audit.list, scoped("empty"))).toEqual([]);
  });

  test("run IDs, paginated events, sequence numbers, updates and crash recovery stay scoped", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const args = scoped(workspace);
      expect(await t.query(api.runs.get, { ...args, runId: "same-run" })).toBeNull();
      expect(
        await t.mutation(api.runs.create, { ...await owned(t, workspace), runId: "same-run", json: JSON.stringify(run(workspace)) }),
      ).toBe(true);
      expect(
        await t.mutation(api.runs.appendEvents, { ...await owned(t, workspace), runId: "same-run", events: [event(label(workspace))] }),
      ).toBe(0);
    }
    for (const workspace of scopes) {
      const args = scoped(workspace);
      expect(
        await t.mutation(api.runs.appendEvents, {
          ...await owned(t, workspace),
          runId: "same-run",
          events: [event(`${label(workspace)}-next`)],
        }),
      ).toBe(1);
      for (const filter of [{}, { status: "running" }, { trailId }, { trailId, status: "running" }]) {
        expect((await t.query(api.runs.list, { ...args, ...filter, limit: 1 })).map(parse)).toEqual([
          expect.objectContaining({ engine: label(workspace) }),
        ]);
      }
      expect((await t.query(api.runs.events, { ...args, runId: "same-run", limit: 1 })).map(parse)).toEqual([
        expect.objectContaining({ seq: 0, text: label(workspace) }),
      ]);
      expect((await t.query(api.runs.events, { ...args, runId: "same-run", after: 0, limit: 1 })).map(parse)).toEqual([
        expect.objectContaining({ seq: 1, text: `${label(workspace)}-next` }),
      ]);
    }
    await expect(
      t.mutation(api.runs.appendEvents, { ...await owned(t, "empty"), runId: "same-run", events: [event("wrong")] }),
    ).rejects.toThrow("unknown run");
    await successor(t, "workspace-a");
    expect(
      await t.mutation(api.runs.closeRunning, { ...await owned(t, "workspace-a"), reason: "a restart", endedAt: later }),
    ).toBe(1);
    expect(
      await t.mutation(api.runs.update, {
        ...await owned(t, "workspace-b"),
        runId: "same-run",
        json: JSON.stringify(run("workspace-b", { status: "done", endedAt: later })),
      }),
    ).toBe(true);
    for (const workspace of scopes) {
      expect(parse(await t.query(api.runs.get, { ...scoped(workspace), runId: "same-run" }))).toMatchObject({
        status: workspace === "workspace-a" ? "failed" : workspace === "workspace-b" ? "done" : "running",
      });
    }
    await successor(t, undefined);
    expect(
      await t.mutation(api.runs.closeRunning, { ...await owned(t, undefined), reason: "legacy restart", endedAt: later }),
    ).toBe(1);
  });

  test("draft ID replacements and status lists do not overwrite or expose another workspace", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const args = scoped(workspace);
      expect(await t.query(api.drafts.get, { ...args, draftId: "same-draft" })).toBeNull();
      await t.mutation(api.drafts.put, { ...args, draftId: "same-draft", json: JSON.stringify(draft(workspace)) });
    }
    await t.mutation(api.drafts.put, {
      ...scoped("workspace-a"),
      draftId: "same-draft",
      json: JSON.stringify(draft("workspace-a", { content: "a changed", status: "discarded" })),
    });
    for (const workspace of scopes) {
      const args = scoped(workspace);
      const expected = workspace === "workspace-a" ? "a changed" : label(workspace);
      expect(parse(await t.query(api.drafts.get, { ...args, draftId: "same-draft" })).content).toBe(expected);
      expect((await t.query(api.drafts.list, args)).map((json) => parse(json).content)).toEqual([expected]);
      expect((await t.query(api.drafts.list, { ...args, status: "open" })).map((json) => parse(json).content)).toEqual(
        workspace === "workspace-a" ? [] : [expected],
      );
    }
    expect(await t.query(api.drafts.list, scoped("empty"))).toEqual([]);
  });

  test("usage idempotency keys do not suppress another workspace's usage or reveal its entries", async () => {
    const t = convexTest(schema, modules);
    for (const workspace of scopes) {
      const entry = {
        id: "same-usage",
        idempotencyKey: "same-key",
        at,
        kind: "draft",
        persona: "velum",
        step: "draft",
        engine: label(workspace),
        trailId: null,
        short: null,
        tokens: null,
        costMicrousd: null,
        wallMs: null,
        outcome: "ok",
        billedTo: "unknown",
      };
      await t.mutation(api.usage.record, { ...scoped(workspace), key: "same-key", json: JSON.stringify(entry) });
      await t.mutation(api.usage.record, {
        ...scoped(workspace),
        key: "same-key",
        json: JSON.stringify({ ...entry, engine: "duplicate" }),
      });
    }
    for (const workspace of scopes) {
      expect((await t.query(api.usage.list, scoped(workspace))).map((json) => parse(json).engine)).toEqual([
        label(workspace),
      ]);
    }
    expect(await t.query(api.usage.list, scoped("empty"))).toEqual([]);
  });

  test("bounded lists and claims select workspace before applying their limit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.ledger.recordReconciliation, { ...scoped("workspace-a"), key: "a", note: "a", at });
    // Populate more than each fixed limit in another workspace, with ordering that would crowd out A.
    await t.run(async (ctx) => {
      for (let index = 0; index < 210; index++) {
        await ctx.db.insert("jobs", {
          workspace: "workspace-b",
          key: `other-${index}`,
          kind: "triage",
          payload: "b",
          status: "queued",
          runAtMs: 0,
          attempts: 0,
        });
        await ctx.db.insert("drafts", {
          workspace: "workspace-b",
          draftId: `other-${index}`,
          status: "open",
          json: JSON.stringify(draft("workspace-b")),
          updatedMs: Date.parse(later),
        });
        await ctx.db.insert("reconciliations", { workspace: "workspace-b", key: `other-${index}`, note: "b", at });
      }
    });
    await t.mutation(api.runtime.enqueue, {
      ...scoped("workspace-a"),
      key: "a",
      kind: "triage",
      payload: "a",
      runAtMs: 1,
    });
    await t.mutation(api.drafts.put, {
      ...scoped("workspace-a"),
      draftId: "same-draft",
      json: JSON.stringify(draft("workspace-a")),
    });
    expect((await t.query(api.runtime.activeJobs, scoped("workspace-a"))).map((job) => job.key)).toEqual(["a"]);
    expect(
      (await t.mutation(api.runtime.claim, { ...await owned(t, "workspace-a"), nowMs: 1, limit: 1 })).map((job) => job.key),
    ).toEqual(["a"]);
    expect(
      (await t.query(api.drafts.list, { ...scoped("workspace-a"), status: "open" })).map((json) => parse(json).content),
    ).toEqual(["workspace-a"]);
    expect(await t.query(api.ledger.reconciliations, scoped("workspace-a"))).toEqual([{ key: "a", note: "a", at }]);
    expect(await t.query(api.runtime.activeJobs, scoped(undefined))).toEqual([]);
    expect(await t.query(api.drafts.list, scoped(undefined))).toEqual([]);
    expect(await t.query(api.ledger.reconciliations, scoped(undefined))).toEqual([]);
  });
});

test("scoped Convex client binds methods and overrides caller namespaces without mutating arguments or the base client", async () => {
  const client = new ConvexHttpClient("https://test.convex.cloud");
  const calls: { method: string; args: Record<string, unknown>; receiver: unknown }[] = [];
  for (const method of ["query", "mutation"]) {
    Object.defineProperty(client, method, {
      configurable: true,
      value: async function (this: unknown, _reference: unknown, args: Record<string, unknown>) {
        calls.push({ method, args, receiver: this });
        return method === "query" ? "typed result" : undefined;
      },
    });
  }
  const bound = scopedConvexClient(client, "workspace-a");
  const supplied = { secret, workspace: "workspace-b", trailId };
  // This assignment also guards the public client's inferred query result type.
  const result: string | null = await bound.query(api.runtime.getTrail, supplied);
  expect(result).toBe("typed result");
  await bound.mutation(api.runtime.finish, { secret, key: "shared", workspace: "workspace-b" });
  await client.query(api.runtime.getTrail, { secret, trailId });
  expect(calls.map(({ method, args }) => [method, args.workspace])).toEqual([
    ["query", "workspace-a"],
    ["mutation", "workspace-a"],
    ["query", undefined],
  ]);
  expect(calls.every(({ receiver }) => receiver === client)).toBe(true);
  expect(supplied.workspace).toBe("workspace-b");
  await expect(bound.query(makeFunctionReference<"query">("auth:getSession"), { secret })).rejects.toThrow(
    "project-data",
  );
  await expect(bound.query(makeFunctionReference<"query">("accounts:get"), { secret })).rejects.toThrow("project-data");
  expect(calls).toHaveLength(3);
  expect(() => scopedConvexClient(client, "")).toThrow("workspace identifier");
});
