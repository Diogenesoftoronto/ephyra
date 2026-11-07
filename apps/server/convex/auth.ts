// Not Organic sign-in records. Server-only (shared secret); the server seals secrets and hashes tokens first.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

const TX_TTL_MS = 10 * 60_000;
const GRANT_TTL_MS = 10 * 60_000;

export const putTx = mutation({
  args: { secret: v.string(), state: v.string(), json: v.string() },
  handler: async (ctx, { secret, state, json }) => {
    requireSecret(secret);
    await ctx.db.insert("authTx", { state, json, createdMs: Date.now() });
  },
});

/** Single use: the transaction is deleted whether or not it is still fresh. */
export const takeTx = mutation({
  args: { secret: v.string(), state: v.string() },
  handler: async (ctx, { secret, state }) => {
    requireSecret(secret);
    const row = await ctx.db.query("authTx").withIndex("by_state", (q) => q.eq("state", state)).unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    return Date.now() - row.createdMs <= TX_TTL_MS ? row.json : null;
  },
});

export const putSession = mutation({
  args: { secret: v.string(), sessionHash: v.string(), did: v.string(), json: v.string(), createdMs: v.number(), expiresMs: v.number() },
  handler: async (ctx, a) => {
    requireSecret(a.secret);
    const row = await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("sessionHash", a.sessionHash)).unique();
    if (row) throw new Error("session exists");
    const version = (JSON.parse(a.json) as { version: number }).version;
    await ctx.db.insert("sessions", { sessionHash: a.sessionHash, did: a.did, json: a.json, version, createdMs: a.createdMs, expiresMs: a.expiresMs });
  },
});

export const getSession = query({
  args: { secret: v.string(), sessionHash: v.string() },
  handler: async (ctx, { secret, sessionHash }) => {
    requireSecret(secret);
    const row = await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("sessionHash", sessionHash)).unique();
    return row && row.expiresMs > Date.now() ? row.json : null;
  },
});

export const latestSessionFor = query({
  args: { secret: v.string(), did: v.string(), nowMs: v.number() },
  handler: async (ctx, { secret, did, nowMs }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("sessions").withIndex("by_did_created", (q) => q.eq("did", did)).order("desc").take(20);
    return rows.find((r) => r.expiresMs > nowMs)?.json ?? null;
  },
});

/** Compare-and-swap on version, so two rotations can never both win. */
export const updateSealed = mutation({
  args: { secret: v.string(), sessionHash: v.string(), expectedVersion: v.number(), sealed: v.string() },
  handler: async (ctx, { secret, sessionHash, expectedVersion, sealed }) => {
    requireSecret(secret);
    const row = await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("sessionHash", sessionHash)).unique();
    if (!row || row.version !== expectedVersion) return false;
    const record = { ...(JSON.parse(row.json) as Record<string, unknown>), sealed, version: expectedVersion + 1 };
    await ctx.db.patch(row._id, { json: JSON.stringify(record), version: expectedVersion + 1 });
    return true;
  },
});

export const deleteSession = mutation({
  args: { secret: v.string(), sessionHash: v.string() },
  handler: async (ctx, { secret, sessionHash }) => {
    requireSecret(secret);
    const row = await ctx.db.query("sessions").withIndex("by_hash", (q) => q.eq("sessionHash", sessionHash)).unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const putGrant = mutation({
  args: { secret: v.string(), challenge: v.string(), json: v.string() },
  handler: async (ctx, { secret, challenge, json }) => {
    requireSecret(secret);
    const row = await ctx.db.query("cliGrants").withIndex("by_challenge", (q) => q.eq("challenge", challenge)).unique();
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("cliGrants", { challenge, json, approved: false, createdMs: Date.now() });
  },
});

export const getGrant = query({
  args: { secret: v.string(), challenge: v.string() },
  handler: async (ctx, { secret, challenge }) => {
    requireSecret(secret);
    const row = await ctx.db.query("cliGrants").withIndex("by_challenge", (q) => q.eq("challenge", challenge)).unique();
    return row && Date.now() - row.createdMs <= GRANT_TTL_MS ? row.json : null;
  },
});

export const approveGrant = mutation({
  args: { secret: v.string(), challenge: v.string(), csrf: v.string() },
  handler: async (ctx, { secret, challenge, csrf }) => {
    requireSecret(secret);
    const row = await ctx.db.query("cliGrants").withIndex("by_challenge", (q) => q.eq("challenge", challenge)).unique();
    if (!row || Date.now() - row.createdMs > GRANT_TTL_MS) return false;
    const grant = JSON.parse(row.json) as { csrf: string };
    if (grant.csrf !== csrf) return false;
    await ctx.db.patch(row._id, { approved: true, json: JSON.stringify({ ...grant, approved: true }) });
    return true;
  },
});

export const takeApprovedGrant = mutation({
  args: { secret: v.string(), challenge: v.string() },
  handler: async (ctx, { secret, challenge }) => {
    requireSecret(secret);
    const row = await ctx.db.query("cliGrants").withIndex("by_challenge", (q) => q.eq("challenge", challenge)).unique();
    if (!row || !row.approved || Date.now() - row.createdMs > GRANT_TTL_MS) return null;
    await ctx.db.delete(row._id);
    return row.json;
  },
});
