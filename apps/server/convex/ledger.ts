// Operation ledger (core OperationLedger port) and reconciliation records.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

const record = (r: { key: string; planDigest: string; status: string; result?: string; at: string }) => ({
  key: r.key, planDigest: r.planDigest, status: r.status, result: r.result ?? null, at: r.at,
});

export const begin = mutation({
  args: { secret: v.string(), key: v.string(), planDigest: v.string(), at: v.string() },
  handler: async (ctx, { secret, key, planDigest, at }) => {
    requireSecret(secret);
    const row = await ctx.db.query("operations").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) {
      if (row.planDigest !== planDigest) throw new Error(`operation key reused: ${key}`);
      return { fresh: false, record: record(row) };
    }
    await ctx.db.insert("operations", { key, planDigest, status: "pending", at });
    return { fresh: true, record: null };
  },
});

export const complete = mutation({
  args: { secret: v.string(), key: v.string(), result: v.string() },
  handler: async (ctx, { secret, key, result }) => {
    requireSecret(secret);
    const row = await ctx.db.query("operations").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row || row.status !== "pending") throw new Error("operation is not pending");
    await ctx.db.patch(row._id, { status: "done", result });
  },
});

export const markAmbiguous = mutation({
  args: { secret: v.string(), key: v.string(), note: v.string() },
  handler: async (ctx, { secret, key, note }) => {
    requireSecret(secret);
    const row = await ctx.db.query("operations").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row || row.status !== "pending") throw new Error("operation is not pending");
    await ctx.db.patch(row._id, { status: "reconciliation_required", result: JSON.stringify(note) });
  },
});

export const get = query({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    requireSecret(secret);
    const row = await ctx.db.query("operations").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row ? record(row) : null;
  },
});

export const recordReconciliation = mutation({
  args: { secret: v.string(), key: v.string(), note: v.string(), at: v.string() },
  handler: async (ctx, { secret, key, note, at }) => {
    requireSecret(secret);
    const row = await ctx.db.query("reconciliations").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) await ctx.db.insert("reconciliations", { key, note, at });
  },
});

export const reconciliations = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireSecret(secret);
    return (await ctx.db.query("reconciliations").order("desc").take(100)).map((r) => ({ key: r.key, note: r.note, at: r.at }));
  },
});
