import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { convexTest } from "convex-test";
import fc from "fast-check";
import { TeamState } from "@ephyra/core";
import { ConvexAccountStore, MemoryAccountStore, type AccountStore } from "../src/setup/account-store";
import { initialAccount, workspaceId } from "../src/setup/accounts";
import { Teams } from "../src/setup/team";
import { TeamRecord } from "../src/setup/team-record";
import schema from "./schema";

const modules = {
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./accounts.ts": () => import("./accounts"),
};
const SECRET = "s".repeat(40), ALICE = "did:plc:alice", BOB = "did:plc:bob", CAROL = "did:plc:carol";
let prior: string | undefined;
beforeEach(() => { prior = process.env.EPHYRA_CONVEX_SECRET; process.env.EPHYRA_CONVEX_SECRET = SECRET; });
afterEach(() => { if (prior === undefined) delete process.env.EPHYRA_CONVEX_SECRET; else process.env.EPHYRA_CONVEX_SECRET = prior; });
const backends: { name: string; make: () => AccountStore }[] = [
  { name: "memory", make: () => new MemoryAccountStore() },
  { name: "Convex", make: () => {
    const t = convexTest(schema, modules);
    const client = new ConvexHttpClient("https://test.convex.cloud");
    Object.defineProperties(client, { query: { value: t.query.bind(t) }, mutation: { value: t.mutation.bind(t) } });
    return new ConvexAccountStore(client, SECRET);
  } },
];

for (const backend of backends) describe(`${backend.name} workspace invitations`, () => {
  async function fixture() {
    const store = backend.make();
    let now = Date.parse("2026-11-08T12:00:00.000Z");
    const teams = new Teams(store, SECRET, () => now);
    await store.ensure({ ...initialAccount(ALICE), modelKey: "sealed-model", repoToken: "sealed-repo" });
    const input = { expectedVersion: 0, workspaceId: workspaceId(ALICE), label: "Design review", role: "viewer" as const };
    return { store, teams, input, advance: (ms: number) => { now += ms; } };
  }

  test("create replay returns one stable link and current revocation; changed input or stale version conflicts", async () => {
    const f = await fixture();
    const created = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    expect(created.invitationId).toBe(created.team.invitations[0]!.id);
    expect(created.team.version).toBe(1);
    expect(TeamState.parse(created.team)).toEqual(created.team);
    expect(await f.teams.invite(ALICE, f.input, "invite-key-0001")).toEqual(created);
    await expect(f.teams.invite(ALICE, { ...f.input, role: "approver" }, "invite-key-0001")).rejects.toThrow("operation key");
    await expect(f.teams.invite(ALICE, f.input, "invite-key-0002")).rejects.toThrow("changed");
    await expect(f.teams.invite(BOB, f.input, "invite-key-0001")).rejects.toThrow("workspace changed");
    const envelope = JSON.parse(Buffer.from(created.token, "base64url").toString());
    const privateState = await f.store.get(ALICE);
    expect(privateState?.team?.invitations[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    for (const value of [created.token, envelope.secret]) expect(JSON.stringify(privateState)).not.toContain(value);
    expect(JSON.stringify(created.team)).not.toContain("tokenHash");
    expect(privateState?.modelKey).toBe("sealed-model");
    const revoke = { expectedVersion: 1, workspaceId: f.input.workspaceId, id: created.invitationId! };
    const revoked = await f.teams.revoke(ALICE, revoke, "revoke-key-0001");
    expect(revoked.invitations[0]?.revokedAt).not.toBeNull();
    const replay = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    expect(replay.token).toBe(created.token);
    expect(replay.team).toEqual(revoked);
    expect(await f.teams.revoke(ALICE, revoke, "revoke-key-0001")).toEqual(revoked);
    await expect(f.teams.accept(BOB, created.token, "accept-key-0001")).rejects.toThrow("revoked");
  });

  test("single-use acceptance binds authenticated principal, replays only its original key, and prevents duplicate grants", async () => {
    const f = await fixture();
    const invited = await f.teams.invite(ALICE, { ...f.input, role: "approver" }, "invite-key-0001");
    await expect(f.teams.accept(ALICE, invited.token, "accept-key-owner")).rejects.toThrow("already own");
    const access = await f.teams.accept(BOB, invited.token, "accept-key-0001");
    expect(access).toMatchObject({ ownerDid: ALICE, workspaceId: f.input.workspaceId, role: "approver" });
    expect(await f.teams.accept(BOB, invited.token, "accept-key-0001")).toEqual(access);
    await expect(f.teams.accept(BOB, invited.token, "accept-key-0002")).rejects.toThrow("already been used");
    await expect(f.teams.accept(CAROL, invited.token, "accept-key-0001")).rejects.toThrow("already been used");
    expect(await f.teams.canApprove(ALICE, f.input.workspaceId, BOB)).toBe(true);
    expect(await f.teams.canApprove(CAROL, f.input.workspaceId, BOB)).toBe(false);
    expect((await f.teams.workspaces(BOB)).map((x) => x.role)).toEqual(["owner", "approver"]);
    const next = await f.teams.invite(ALICE, { ...f.input, expectedVersion: 2 }, "invite-key-0002");
    await expect(f.teams.accept(BOB, next.token, "accept-key-0001")).rejects.toThrow("operation key");
    await expect(f.teams.accept(BOB, next.token, "accept-key-0003")).rejects.toThrow("already have access");
    await f.teams.revoke(ALICE, { expectedVersion: 3, workspaceId: f.input.workspaceId, id: invited.invitationId! }, "revoke-key-0001");
    expect(await f.teams.canApprove(ALICE, f.input.workspaceId, BOB)).toBe(false);
    await expect(f.teams.accept(BOB, invited.token, "accept-key-0001")).rejects.toThrow("revoked");
    expect(await f.teams.shared(BOB, f.input.workspaceId)).toBeNull();
    await f.teams.accept(BOB, next.token, "accept-key-0004");
    expect((await f.teams.shared(BOB, f.input.workspaceId))?.access.role).toBe("viewer");
    expect(await f.teams.stillShared(ALICE, f.input.workspaceId, BOB, invited.invitationId!)).toBe(false);
  });

  test("expiration applies at seven days; redeemed membership persists until revoked", async () => {
    const f = await fixture();
    const first = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    await f.teams.accept(BOB, first.token, "accept-key-0001");
    const second = await f.teams.invite(ALICE, { ...f.input, expectedVersion: 2 }, "invite-key-0002");
    f.advance(7 * 86400_000);
    await expect(f.teams.accept(CAROL, second.token, "accept-key-0002")).rejects.toThrow("expired");
    expect(await f.teams.accept(BOB, first.token, "accept-key-0001")).toMatchObject({ role: "viewer" });
    expect((await f.teams.shared(BOB, f.input.workspaceId))?.access.role).toBe("viewer");
  });

  test("simultaneous acceptance has one winner and forged envelopes cannot cross owners", async () => {
    const f = await fixture();
    const created = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    const results = await Promise.allSettled([
      f.teams.accept(BOB, created.token, "accept-key-0001"),
      f.teams.accept(CAROL, created.token, "accept-key-0002"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.store.get(ALICE))?.settings.version).toBe(2);
    const envelope = JSON.parse(Buffer.from(created.token, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...envelope, owner: BOB })).toString("base64url");
    await expect(f.teams.accept(CAROL, forged, "accept-key-forged")).rejects.toThrow("unavailable");
    await expect(f.teams.accept(CAROL, "not-an-invitation", "accept-key-invalid")).rejects.toThrow("invalid");
  });

  test("workspace changes erase grants in persistent authority, including a switch back", async () => {
    const f = await fixture();
    const created = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    await f.teams.accept(BOB, created.token, "accept-key-0001");
    const original = (await f.store.get(ALICE))!;
    for (const [key, workspace] of [["switch-out", workspaceId(ALICE, "https://example.com/other")], ["switch-back", f.input.workspaceId]]) {
      const current = (await f.store.get(ALICE))!;
      const changed = structuredClone(current);
      changed.settings.workspaceId = workspace!;
      changed.settings.version++;
      // Simulate a caller retaining a stale team object: the store must still invalidate it.
      changed.team = original.team;
      expect(await f.store.begin(ALICE, key!, key!, current.settings.version)).toEqual({ status: "fresh" });
      expect(await f.store.complete(ALICE, key!, key!, changed)).toBe(true);
      expect((await f.store.get(ALICE))?.team).toBeUndefined();
      expect(await f.teams.shared(BOB, f.input.workspaceId)).toBeNull();
    }
    await expect(f.teams.accept(BOB, created.token, "accept-key-0001")).rejects.toThrow("unavailable");
    await expect(f.teams.invite(ALICE, f.input, "invite-key-0001")).rejects.toThrow("no longer");
  });

  test("private schema rejects raw tokens and duplicate active member grants", async () => {
    const f = await fixture();
    const created = await f.teams.invite(ALICE, f.input, "invite-key-0001");
    await f.teams.accept(BOB, created.token, "accept-key-0001");
    const record = (await f.store.get(ALICE))!;
    const item = record.team!.invitations[0]!;
    expect(TeamRecord.safeParse({ ...record.team, token: created.token }).success).toBe(false);
    expect(TeamRecord.safeParse({ ...record.team, invitations: [item, { ...item, id: `invite_${"f".repeat(32)}` }] }).success).toBe(false);
    await expect(f.store.ensure({ ...initialAccount(CAROL), team: { ...record.team!, invitations: [{ ...item, tokenHash: created.token }] } })).rejects.toThrow();
  });
});

test("altering any secret character cannot transfer workspace authority", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 42 }), fc.integer({ min: 1, max: 63 }), async (position, offset) => {
    const store = new MemoryAccountStore();
    const teams = new Teams(store, SECRET);
    const created = await teams.invite(ALICE, { expectedVersion: 0, workspaceId: workspaceId(ALICE), label: "Review", role: "viewer" }, "invite-key-0001");
    const envelope = JSON.parse(Buffer.from(created.token, "base64url").toString());
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    const changed = alphabet[(alphabet.indexOf(envelope.secret[position]) + offset) % alphabet.length];
    const forgedSecret = envelope.secret.slice(0, position) + changed + envelope.secret.slice(position + 1);
    const forged = Buffer.from(JSON.stringify({ ...envelope, secret: forgedSecret })).toString("base64url");
    await expect(teams.accept(BOB, forged, "accept-key-0001")).rejects.toThrow();
    expect(await teams.shared(BOB, workspaceId(ALICE))).toBeNull();
  }), { numRuns: 25 });
});
