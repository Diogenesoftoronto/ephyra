// Agent runs and their event streams. The server owns the shapes (AgentRun / AgentRunEvent, validated with core's zod schemas on both
// sides of every call); Convex stores JSON plus the scalar columns it indexes. `appendEvents` assigns seq inside one serializable mutation,
// so concurrent writers can never produce a duplicate or a gap.
import { AgentRun, AgentRunEvent } from "@ephyra/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";
import { ownsWorker, requireWorker } from "./worker_owner";

const MAX_BATCH = 100;
const MAX_PAGE = 500;

/** Idempotent by run id: creating a run twice keeps the first. */
export const create = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), runId: v.string(), json: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, runId, json, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
    const run = AgentRun.parse(JSON.parse(json));
    if (run.id !== runId) throw new Error("run id mismatch");
    const existing = await ctx.db.query("runs")
      .withIndex("by_workspace_run_id", (q) => q.eq("workspace", workspace).eq("runId", runId)).unique();
    if (existing) return false;
    await ctx.db.insert("runs", { workspace, runId, ownerId, ownerFence: fence,
      ...(run.trailId ? { trailId: run.trailId } : {}), status: run.status, startedMs: Date.parse(run.startedAt), json });
    return true;
  },
});

export const update = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), runId: v.string(), json: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, runId, json, ownerId, fence }) => {
    requireSecret(secret);
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return false;
    const run = AgentRun.parse(JSON.parse(json));
    if (run.id !== runId) throw new Error("run id mismatch");
    const row = await ctx.db.query("runs")
      .withIndex("by_workspace_run_id", (q) => q.eq("workspace", workspace).eq("runId", runId)).unique();
    if (!row || row.ownerId !== ownerId || row.ownerFence !== fence) return false;
    await ctx.db.patch(row._id, { status: run.status, json });
    return true;
  },
});

export const get = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), runId: v.string() },
  handler: async (ctx, { workspace, secret, runId }) => {
    requireSecret(secret);
    return (await ctx.db.query("runs")
      .withIndex("by_workspace_run_id", (q) => q.eq("workspace", workspace).eq("runId", runId)).unique())?.json ?? null;
  },
});

/** Newest first. Filters by trail and/or status; the result is bounded. */
export const list = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), trailId: v.optional(v.string()), status: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { workspace, secret, trailId, status, limit }) => {
    requireSecret(secret);
    const n = Math.max(1, Math.min(limit, 200));
    const base = trailId
      ? ctx.db.query("runs").withIndex("by_workspace_trail_started", (q) => q.eq("workspace", workspace).eq("trailId", trailId))
      : status
        ? ctx.db.query("runs").withIndex("by_workspace_status_started", (q) => q.eq("workspace", workspace).eq("status", status))
        : ctx.db.query("runs").withIndex("by_workspace_started", (q) => q.eq("workspace", workspace));
    const rows = await base.order("desc").take(trailId && status ? 400 : n);
    return rows.filter((r) => !status || r.status === status).slice(0, n).map((r) => r.json);
  },
});

/** Appends events (without seq) in order and returns the first seq used. */
export const appendEvents = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), runId: v.string(), events: v.array(v.string()),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, runId, events, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
    if (events.length > MAX_BATCH) throw new Error("too many events in one batch");
    const run = await ctx.db.query("runs")
      .withIndex("by_workspace_run_id", (q) => q.eq("workspace", workspace).eq("runId", runId)).unique();
    if (!run) throw new Error("unknown run");
    if (run.ownerId !== ownerId || run.ownerFence !== fence) throw new Error("Run belongs to a previous worker; reconcile it before continuing");
    const last = await ctx.db.query("runEvents")
      .withIndex("by_workspace_run_seq", (q) => q.eq("workspace", workspace).eq("runId", runId)).order("desc").first();
    let seq = last ? last.seq + 1 : 0;
    const first = seq;
    for (const json of events) {
      const event = AgentRunEvent.parse({ ...JSON.parse(json), runId, seq });
      await ctx.db.insert("runEvents", { workspace, runId, seq, json: JSON.stringify(event) });
      seq += 1;
    }
    return first;
  },
});

/** Events with seq greater than `after` (all when omitted), oldest first. */
export const events = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), runId: v.string(), after: v.optional(v.number()), limit: v.number() },
  handler: async (ctx, { workspace, secret, runId, after, limit }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("runEvents")
      .withIndex("by_workspace_run_seq", (q) => {
        const run = q.eq("workspace", workspace).eq("runId", runId);
        return after === undefined ? run : run.gt("seq", after);
      })
      .order("asc").take(Math.max(1, Math.min(limit, MAX_PAGE)));
    return rows.map((r) => r.json);
  },
});

/** Only the current workspace owner may close transcripts abandoned by a previous owner. */
export const closeRunning = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), reason: v.string(), endedAt: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, reason, endedAt, ownerId, fence }) => {
    requireSecret(secret);
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return 0;
    const rows = await ctx.db.query("runs")
      .withIndex("by_workspace_status_started", (q) => q.eq("workspace", workspace).eq("status", "running"))
      .filter((q) => q.or(q.neq(q.field("ownerId"), ownerId), q.neq(q.field("ownerFence"), fence))).collect();
    for (const row of rows) {
      const run = AgentRun.parse(JSON.parse(row.json));
      await ctx.db.patch(row._id, { status: "failed", json: JSON.stringify({ ...run, status: "failed", endedAt, error: reason.slice(0, 500) }) });
    }
    return rows.length;
  },
});
