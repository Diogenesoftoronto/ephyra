import { UsageEntry } from "@ephyra/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

export const record = mutation({
  args: { secret: v.string(), key: v.string(), json: v.string() },
  handler: async (ctx, { secret, key, json }) => {
    requireSecret(secret);
    const entry = UsageEntry.parse(JSON.parse(json));
    if (entry.idempotencyKey !== key) throw new Error("usage key mismatch");
    const existing = await ctx.db.query("usage").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (existing) return;
    await ctx.db.insert("usage", { key, json });
  },
});
export const list = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireSecret(secret);
    return (await ctx.db.query("usage").collect()).map((row) => row.json);
  },
});
