// Agent runs and their event streams. The server owns the shapes (AgentRun / AgentRunEvent, validated with core's zod schemas on both
// sides of every call); Convex stores JSON plus the scalar columns it indexes. `appendEvents` assigns seq inside one serializable mutation,
// so concurrent writers can never produce a duplicate or a gap.
import { AgentRun, AgentRunEvent } from "@ephyra/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

const MAX_BATCH = 100;
const MAX_PAGE = 500;

/** Idempotent by run id: creating a run twice keeps the first. */
export const create = mutation({
  args: { secret: v.string(), runId: v.string(), json: v.string() },
  handler: async (ctx, { secret, runId, json }) => {
    requireSecret(secret);
    const run = AgentRun.parse(JSON.parse(json));
    if (run.id !== runId) throw new Error("run id mismatch");
    const existing = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
    if (existing) return false;
    await ctx.db.insert("runs", { runId, ...(run.trailId ? { trailId: run.trailId } : {}), status: run.status, startedMs: Date.parse(run.startedAt), json });
    return true;
  },
});

export const update = mutation({
  args: { secret: v.string(), runId: v.string(), json: v.string() },
  handler: async (ctx, { secret, runId, json }) => {
    requireSecret(secret);
    const run = AgentRun.parse(JSON.parse(json));
    if (run.id !== runId) throw new Error("run id mismatch");
    const row = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
    if (!row) return false;
    await ctx.db.patch(row._id, { status: run.status, json });
    return true;
  },
});

export const get = query({
  args: { secret: v.string(), runId: v.string() },
  handler: async (ctx, { secret, runId }) => {
    requireSecret(secret);
    return (await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique())?.json ?? null;
  },
});

/** Newest first. Filters by trail and/or status; the result is bounded. */
export const list = query({
  args: { secret: v.string(), trailId: v.optional(v.string()), status: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { secret, trailId, status, limit }) => {
    requireSecret(secret);
    const n = Math.max(1, Math.min(limit, 200));
    const base = trailId
      ? ctx.db.query("runs").withIndex("by_trail_started", (q) => q.eq("trailId", trailId))
      : status
        ? ctx.db.query("runs").withIndex("by_status_started", (q) => q.eq("status", status))
        : ctx.db.query("runs").withIndex("by_started");
    const rows = await base.order("desc").take(trailId && status ? 400 : n);
    return rows.filter((r) => !status || r.status === status).slice(0, n).map((r) => r.json);
  },
});

/** Appends events (without seq) in order and returns the first seq used. */
export const appendEvents = mutation({
  args: { secret: v.string(), runId: v.string(), events: v.array(v.string()) },
  handler: async (ctx, { secret, runId, events }) => {
    requireSecret(secret);
    if (events.length > MAX_BATCH) throw new Error("too many events in one batch");
    const run = await ctx.db.query("runs").withIndex("by_run_id", (q) => q.eq("runId", runId)).unique();
    if (!run) throw new Error("unknown run");
    const last = await ctx.db.query("runEvents").withIndex("by_run_seq", (q) => q.eq("runId", runId)).order("desc").first();
    let seq = last ? last.seq + 1 : 0;
    const first = seq;
    for (const json of events) {
      const event = AgentRunEvent.parse({ ...JSON.parse(json), runId, seq });
      await ctx.db.insert("runEvents", { runId, seq, json: JSON.stringify(event) });
      seq += 1;
    }
    return first;
  },
});

/** Events with seq greater than `after` (all when omitted), oldest first. */
export const events = query({
  args: { secret: v.string(), runId: v.string(), after: v.optional(v.number()), limit: v.number() },
  handler: async (ctx, { secret, runId, after, limit }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("runEvents")
      .withIndex("by_run_seq", (q) => (after === undefined ? q.eq("runId", runId) : q.eq("runId", runId).gt("seq", after)))
      .order("asc").take(Math.max(1, Math.min(limit, MAX_PAGE)));
    return rows.map((r) => r.json);
  },
});

/** Marks runs left running by a crashed server as failed. Returns how many. */
export const closeRunning = mutation({
  args: { secret: v.string(), reason: v.string(), endedAt: v.string() },
  handler: async (ctx, { secret, reason, endedAt }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("runs").withIndex("by_status_started", (q) => q.eq("status", "running")).take(500);
    for (const row of rows) {
      const run = AgentRun.parse(JSON.parse(row.json));
      await ctx.db.patch(row._id, { status: "failed", json: JSON.stringify({ ...run, status: "failed", endedAt, error: reason.slice(0, 500) }) });
    }
    return rows.length;
  },
});
