// Hash-chained audit log. The chain is extended inside one mutation, which Convex runs as a serializable
// transaction, so concurrent appends cannot fork the chain. Hashing matches apps/server/src/audit.ts.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canonicalJson, requireSecret, sha256Hex } from "./lib";

export const append = mutation({
  args: { secret: v.string(), json: v.string() },
  handler: async (ctx, { secret, json }) => {
    requireSecret(secret);
    const input = JSON.parse(json) as { id: string };
    const dup = await ctx.db.query("audit").withIndex("by_audit_id", (q) => q.eq("auditId", input.id)).unique();
    if (dup) throw new Error("audit id reused");
    const last = await ctx.db.query("audit").withIndex("by_seq").order("desc").first();
    const prevHash = last?.hash ?? "";
    const hash = await sha256Hex(prevHash + canonicalJson(input));
    await ctx.db.insert("audit", { seq: (last?.seq ?? 0) + 1, auditId: input.id, json, prevHash, hash });
    return { prevHash, hash };
  },
});

export const list = query({
  args: { secret: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { secret, limit }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("audit").withIndex("by_seq").order("asc").take(Math.min(limit ?? 1000, 5000));
    return rows.map((r) => ({ json: r.json, prevHash: r.prevHash, hash: r.hash }));
  },
});
