// Console policy drafts. The server owns the Draft shape (validated with core's zod schema before every write and after every read);
// Convex stores the JSON plus two scalar columns for indexing.
import { Draft } from "@ephyra/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

export const put = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), draftId: v.string(), json: v.string() },
  handler: async (ctx, { workspace, secret, draftId, json }) => {
    requireSecret(secret);
    const draft = Draft.parse(JSON.parse(json));
    if (draft.id !== draftId) throw new Error("draft id mismatch");
    const fields = { workspace, draftId, status: draft.status, json, updatedMs: Date.parse(draft.updatedAt) };
    const row = await ctx.db.query("drafts")
      .withIndex("by_workspace_draft_id", (q) => q.eq("workspace", workspace).eq("draftId", draftId)).unique();
    if (row) await ctx.db.replace(row._id, fields);
    else await ctx.db.insert("drafts", fields);
  },
});

export const get = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), draftId: v.string() },
  handler: async (ctx, { workspace, secret, draftId }) => {
    requireSecret(secret);
    const row = await ctx.db.query("drafts")
      .withIndex("by_workspace_draft_id", (q) => q.eq("workspace", workspace).eq("draftId", draftId)).unique();
    return row?.json ?? null;
  },
});

/** Newest first. `status` narrows to one status; the list is bounded. */
export const list = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), status: v.optional(v.string()) },
  handler: async (ctx, { workspace, secret, status }) => {
    requireSecret(secret);
    const rows = status
      ? await ctx.db.query("drafts")
        .withIndex("by_workspace_status_updated", (q) => q.eq("workspace", workspace).eq("status", status)).order("desc").take(200)
      : await ctx.db.query("drafts").withIndex("by_workspace", (q) => q.eq("workspace", workspace)).collect();
    return rows.sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 200).map((r) => r.json);
  },
});
