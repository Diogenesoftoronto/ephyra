// Agent authority is separate from human sessions. Only the trusted server can access these records.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

type RegistrationColumns = {
  id: string; claimHash: string; attemptHash?: string; binding?: { ownerDid: string }; revision: number;
};
const columns = (json: string) => {
  const record = JSON.parse(json) as RegistrationColumns;
  return { id: record.id, claimHash: record.claimHash, attemptHash: record.attemptHash,
    ownerDid: record.binding?.ownerDid, revision: record.revision, json };
};

export const create = mutation({
  args: { secret: v.string(), json: v.string() },
  handler: async (ctx, { secret, json }) => {
    requireSecret(secret);
    const record = columns(json);
    if (await ctx.db.query("agentRegistrations").withIndex("by_registration_id", (q) => q.eq("id", record.id)).unique())
      throw new Error("Agent registration already exists.");
    await ctx.db.insert("agentRegistrations", record);
  },
});
export const get = query({
  args: { secret: v.string(), id: v.string() },
  handler: async (ctx, { secret, id }) => {
    requireSecret(secret);
    return (await ctx.db.query("agentRegistrations").withIndex("by_registration_id", (q) => q.eq("id", id)).unique())?.json ?? null;
  },
});
export const byClaim = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, { secret, hash }) => {
    requireSecret(secret);
    return (await ctx.db.query("agentRegistrations").withIndex("by_claim", (q) => q.eq("claimHash", hash)).unique())?.json ?? null;
  },
});
export const byAttempt = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, { secret, hash }) => {
    requireSecret(secret);
    return (await ctx.db.query("agentRegistrations").withIndex("by_attempt", (q) => q.eq("attemptHash", hash)).unique())?.json ?? null;
  },
});
export const replace = mutation({
  args: { secret: v.string(), json: v.string(), expectedRevision: v.number() },
  handler: async (ctx, { secret, json, expectedRevision }) => {
    requireSecret(secret);
    const record = columns(json);
    const row = await ctx.db.query("agentRegistrations").withIndex("by_registration_id", (q) => q.eq("id", record.id)).unique();
    if (!row || row.revision !== expectedRevision || record.revision !== expectedRevision + 1) return false;
    await ctx.db.replace(row._id, record);
    return true;
  },
});
export const putToken = mutation({
  args: { secret: v.string(), hash: v.string(), registrationId: v.string(), version: v.number(), expiresMs: v.number() },
  handler: async (ctx, { secret, ...record }) => {
    requireSecret(secret);
    const prior = await ctx.db.query("agentTokens").withIndex("by_hash", (q) => q.eq("hash", record.hash)).unique();
    if (!prior) await ctx.db.insert("agentTokens", record);
  },
});
export const token = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, { secret, hash }) => {
    requireSecret(secret);
    return ctx.db.query("agentTokens").withIndex("by_hash", (q) => q.eq("hash", hash)).unique();
  },
});
export const list = query({
  args: { secret: v.string(), ownerDid: v.string() },
  handler: async (ctx, { secret, ownerDid }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("agentRegistrations").withIndex("by_owner", (q) => q.eq("ownerDid", ownerDid))
      .order("desc").take(100);
    return rows.map((row) => row.json);
  },
});
