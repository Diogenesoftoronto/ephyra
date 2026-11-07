import { UsageEntry } from "@ephyra/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

export const record = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string(), json: v.string() },
  handler: async (ctx, { workspace, secret, key, json }) => {
    requireSecret(secret);
    const entry = UsageEntry.parse(JSON.parse(json));
    if (entry.idempotencyKey !== key) throw new Error("usage key mismatch");
    const existing = await ctx.db.query("usage")
      .withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (existing) return;
    await ctx.db.insert("usage", { workspace, key, json });
  },
});
export const list = query({
  args: { workspace: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { workspace, secret }) => {
    requireSecret(secret);
    return (await ctx.db.query("usage")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace)).collect()).map((row) => row.json);
  },
});
