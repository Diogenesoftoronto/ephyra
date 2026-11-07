import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import { SecretBox } from "../src/auth/crypto";
import {
  ConvexAccountStore,
  MemoryAccountStore,
  type AccountRecord,
  type AccountStore,
} from "../src/setup/account-store";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./accounts.ts": () => import("./accounts"),
};
const secret = "s".repeat(40);
const alice = "did:plc:alice";
const bob = "did:plc:bob";
const initial = (did: string, version = 0): AccountRecord => ({
  settings: {
    did,
    version,
    workspaceId: `${did}-workspace`,
    repository: null,
    model: {
      provider: "none",
      model: "",
      baseUrl: null,
      keyConfigured: false,
      status: "not_configured",
      checkedAt: null,
      detail: null,
    },
    onboarding: { status: "new", updatedAt: "2026-11-07T10:00:00.000Z" },
    execution: "not_configured",
  },
});
let priorSecret: string | undefined;
beforeEach(() => {
  priorSecret = process.env.EPHYRA_CONVEX_SECRET;
  process.env.EPHYRA_CONVEX_SECRET = secret;
});
afterEach(() => {
  if (priorSecret === undefined) delete process.env.EPHYRA_CONVEX_SECRET;
  else process.env.EPHYRA_CONVEX_SECRET = priorSecret;
});

const stores: { name: string; create: () => AccountStore }[] = [
  { name: "memory", create: () => new MemoryAccountStore() },
  {
    name: "Convex",
    create: () => {
      const t = convexTest(schema, modules);
      const client = new ConvexHttpClient("https://test.convex.cloud");
      Object.defineProperties(client, {
        query: { value: t.query.bind(t) },
        mutation: { value: t.mutation.bind(t) },
      });
      return new ConvexAccountStore(client, secret);
    },
  },
];

for (const backend of stores) {
  describe(`${backend.name} account persistence`, () => {
    test("ensure is idempotent by owner and returned records cannot mutate stored settings", async () => {
      const store = backend.create();
      expect(await store.get(alice)).toBeNull();
      expect(await store.list()).toEqual([]);
      const source = initial(alice);
      const saved = await store.ensure(source);
      source.settings.workspaceId = "changed-source";
      saved.settings.model.model = "changed-result";
      const repeated = initial(alice, 8);
      repeated.settings.workspaceId = "overwrite-attempt";
      expect(await store.ensure(repeated)).toEqual(initial(alice));
      await store.ensure(initial(bob));
      const listed = await store.list();
      expect(listed.map((record) => record.settings.did).sort()).toEqual([alice, bob]);
      listed[0]!.settings.onboarding.status = "complete";
      expect(await store.get(alice)).toEqual(initial(alice));
      expect(await store.get(bob)).toEqual(initial(bob));
    });

    test("the same operation key is independent across DIDs and another digest always conflicts", async () => {
      const store = backend.create();
      await store.ensure(initial(alice));
      await store.ensure(initial(bob));
      expect(await store.begin(alice, "same-key", "alice-digest", 0)).toEqual({ status: "fresh" });
      expect(await store.begin(bob, "same-key", "bob-digest", 0)).toEqual({ status: "fresh" });
      expect(await store.begin(alice, "same-key", "bob-digest", 0)).toEqual({ status: "conflict" });
      expect(await store.complete(alice, "same-key", "alice-digest", initial(alice, 1))).toBe(true);
      expect(await store.begin(alice, "same-key", "alice-digest", 0)).toEqual({
        status: "completed",
        record: initial(alice, 1),
      });
      expect(await store.begin(bob, "same-key", "bob-digest", 0)).toEqual({ status: "pending" });
      expect(await store.get(bob)).toEqual(initial(bob));
      expect(await store.begin(alice, "same-key", "different", 0)).toEqual({ status: "conflict" });
      await store.fail(alice, "same-key", "alice-digest", "late failure");
      expect(await store.begin(alice, "same-key", "alice-digest", 0)).toEqual({
        status: "completed",
        record: initial(alice, 1),
      });
    });

    test("completion receipts replay the original version after later edits and are immutable to callers", async () => {
      const store = backend.create();
      await store.ensure(initial(alice));
      await store.begin(alice, "first", "digest-1", 0);
      expect(await store.complete(alice, "first", "digest-1", initial(alice, 1))).toBe(true);
      expect(await store.complete(alice, "first", "digest-1", initial(alice, 1))).toBe(false);
      expect(await store.begin(alice, "second", "digest-2", 1)).toEqual({ status: "fresh" });
      expect(await store.complete(alice, "second", "digest-2", initial(alice, 2))).toBe(true);
      const replay = await store.begin(alice, "first", "digest-1", 0);
      expect(replay).toEqual({ status: "completed", record: initial(alice, 1) });
      if (replay.status === "completed") replay.record.settings.version = 99;
      expect(await store.begin(alice, "first", "digest-1", 0)).toEqual({
        status: "completed",
        record: initial(alice, 1),
      });
      expect(await store.get(alice)).toEqual(initial(alice, 2));
    });

    test("new reservations check version, and failed attempts replay without reserving again", async () => {
      const store = backend.create();
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({ status: "conflict" });
      await store.ensure(initial(alice));
      expect(await store.begin(alice, "key", "digest", 1)).toEqual({ status: "conflict" });
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({ status: "fresh" });
      await store.fail(alice, "key", "wrong-digest", "wrong error");
      await store.fail(bob, "key", "digest", "another owner");
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({ status: "pending" });
      await store.fail(alice, "key", "digest", "Repository could not be verified.");
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({
        status: "failed",
        error: "Repository could not be verified.",
      });
      expect(await store.begin(alice, "key", "new-digest", 0)).toEqual({ status: "conflict" });
      expect(await store.complete(alice, "key", "digest", initial(alice, 1))).toBe(false);
      expect(await store.get(alice)).toEqual(initial(alice));
      expect(await store.begin(alice, "new-key", "new-digest", 0)).toEqual({ status: "fresh" });
    });

    test("CAS lets only one of two updates reserved at the same version commit", async () => {
      const store = backend.create();
      await store.ensure(initial(alice));
      const reserved = await Promise.all([
        store.begin(alice, "left", "left-digest", 0),
        store.begin(alice, "right", "right-digest", 0),
      ]);
      expect(reserved).toEqual([{ status: "fresh" }, { status: "fresh" }]);
      const left = initial(alice, 1);
      left.settings.onboarding.status = "skipped";
      const right = initial(alice, 1);
      right.settings.onboarding.status = "in_progress";
      const completed = await Promise.all([
        store.complete(alice, "left", "left-digest", left),
        store.complete(alice, "right", "right-digest", right),
      ]);
      expect(completed.filter(Boolean)).toHaveLength(1);
      const winner = completed[0] ? "left" : "right";
      const loser = completed[0] ? "right" : "left";
      const expected = completed[0] ? left : right;
      expect(await store.get(alice)).toEqual(expected);
      expect(await store.begin(alice, winner, `${winner}-digest`, 0)).toEqual({
        status: "completed",
        record: expected,
      });
      expect(await store.begin(alice, loser, `${loser}-digest`, 0)).toEqual({ status: "pending" });
      expect(await store.begin(alice, "stale", "stale-digest", 0)).toEqual({ status: "conflict" });
    });

    test("completion requires matching owner, reservation, digest and exactly the next version", async () => {
      const store = backend.create();
      await store.ensure(initial(alice));
      await store.ensure(initial(bob));
      await store.begin(alice, "key", "digest", 0);
      expect(await store.complete(alice, "missing", "digest", initial(alice, 1))).toBe(false);
      expect(await store.complete(alice, "key", "wrong", initial(alice, 1))).toBe(false);
      expect(await store.complete(alice, "key", "digest", initial(bob, 1))).toBe(false);
      expect(await store.complete(bob, "key", "digest", initial(bob, 1))).toBe(false);
      expect(await store.complete(alice, "key", "digest", initial(alice))).toBe(false);
      expect(await store.complete(alice, "key", "digest", initial(alice, 2))).toBe(false);
      expect(await store.get(alice)).toEqual(initial(alice));
      expect(await store.get(bob)).toEqual(initial(bob));
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({ status: "pending" });
      expect(await store.complete(alice, "key", "digest", initial(alice, 1))).toBe(true);
    });

    test("sealed credentials survive updates but are omitted from receipts and public settings fields", async () => {
      const store = backend.create();
      const box = await SecretBox.fromBase64(Buffer.alloc(32, 7).toString("base64"));
      const record = initial(alice);
      record.modelKey = await box.seal("private-model-key");
      record.repoToken = await box.seal("private-repo-token");
      const saved = await store.ensure(record);
      expect(saved).toEqual(record);
      expect(JSON.stringify(saved)).not.toContain("private-model-key");
      expect(JSON.stringify(saved)).not.toContain("private-repo-token");
      expect(saved.settings).not.toHaveProperty("modelKey");
      expect(saved.settings).not.toHaveProperty("repoToken");
      await store.begin(alice, "key", "digest", 0);
      const updated = { ...record, settings: { ...record.settings, version: 1 } };
      expect(await store.complete(alice, "key", "digest", updated)).toBe(true);
      expect(await store.begin(alice, "key", "digest", 0)).toEqual({
        status: "completed",
        record: { settings: updated.settings },
      });
      expect(await box.open((await store.get(alice))!.modelKey!)).toBe("private-model-key");
    });
  });
}

test("every account Convex function rejects a bad or unconfigured server secret", async () => {
  const t = convexTest(schema, modules);
  const json = JSON.stringify(initial(alice));
  const calls = (provided: string) => [
    () => t.mutation(api.accounts.ensure, { secret: provided, did: alice, json }),
    () => t.query(api.accounts.get, { secret: provided, did: alice }),
    () => t.query(api.accounts.list, { secret: provided }),
    () =>
      t.mutation(api.accounts.begin, {
        secret: provided,
        did: alice,
        key: "key",
        digest: "digest",
        expectedVersion: 0,
      }),
    () => t.mutation(api.accounts.complete, { secret: provided, did: alice, key: "key", digest: "digest", json }),
    () =>
      t.mutation(api.accounts.fail, { secret: provided, did: alice, key: "key", digest: "digest", error: "failed" }),
  ];
  for (const invoke of calls("x".repeat(40))) await expect(invoke()).rejects.toThrow("unauthorized");
  delete process.env.EPHYRA_CONVEX_SECRET;
  for (const invoke of calls(secret)) await expect(invoke()).rejects.toThrow("not configured");
});

test("Convex refuses a forged ensure owner and malformed account JSON without writing any state", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.mutation(api.accounts.ensure, { secret, did: alice, json: JSON.stringify(initial(bob)) }),
  ).rejects.toThrow("account owner mismatch");
  await expect(
    t.mutation(api.accounts.ensure, { secret, did: alice, json: JSON.stringify({ settings: { did: alice } }) }),
  ).rejects.toThrow();
  expect(await t.query(api.accounts.list, { secret })).toEqual([]);
  expect(
    await t.mutation(api.accounts.begin, { secret, did: alice, key: "key", digest: "digest", expectedVersion: 0 }),
  ).toEqual({ status: "conflict" });
});
