// Trail projection, event log, inbox and job queue (RuntimeStore in apps/server/src/wiring/store.ts).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";

// ───── trails ─────
export const getTrail = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), trailId: v.string() },
  handler: async (ctx, { workspace, secret, trailId }) => {
    requireSecret(secret);
    const row = await ctx.db.query("trails")
      .withIndex("by_workspace_trail_id", (q) => q.eq("workspace", workspace).eq("trailId", trailId)).unique();
    return row?.json ?? null;
  },
});

export const putTrail = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), trailId: v.string(), state: v.string(), json: v.string() },
  handler: async (ctx, { workspace, secret, trailId, state, json }) => {
    requireSecret(secret);
    const row = await ctx.db.query("trails")
      .withIndex("by_workspace_trail_id", (q) => q.eq("workspace", workspace).eq("trailId", trailId)).unique();
    if (row) await ctx.db.patch(row._id, { state, json, updatedMs: Date.now() });
    else await ctx.db.insert("trails", { workspace, trailId, state, json, updatedMs: Date.now() });
  },
});

export const listTrails = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), states: v.optional(v.array(v.string())) },
  handler: async (ctx, { workspace, secret, states }) => {
    requireSecret(secret);
    if (!states?.length) return (await ctx.db.query("trails")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace)).collect()).map((r) => r.json);
    const out: string[] = [];
    for (const state of new Set(states)) {
      const rows = await ctx.db.query("trails")
        .withIndex("by_workspace_state", (q) => q.eq("workspace", workspace).eq("state", state)).collect();
      out.push(...rows.map((r) => r.json));
    }
    return out;
  },
});

// ───── events ─────
export const recordEvent = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), eventId: v.string(), trailId: v.string(), json: v.string() },
  handler: async (ctx, { workspace, secret, eventId, trailId, json }) => {
    requireSecret(secret);
    const seen = await ctx.db.query("events")
      .withIndex("by_workspace_event_id", (q) => q.eq("workspace", workspace).eq("eventId", eventId)).unique();
    if (seen) return false;
    await ctx.db.insert("events", { workspace, eventId, trailId, json });
    return true;
  },
});

export const events = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), trailId: v.string() },
  handler: async (ctx, { workspace, secret, trailId }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("events")
      .withIndex("by_workspace_trail", (q) => q.eq("workspace", workspace).eq("trailId", trailId)).collect();
    return rows.map((r) => r.json);
  },
});

// ───── inbox ─────
export const inboxPut = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), itemId: v.string(), trailId: v.string(), json: v.string() },
  handler: async (ctx, { workspace, secret, itemId, trailId, json }) => {
    requireSecret(secret);
    const row = await ctx.db.query("inbox")
      .withIndex("by_workspace_item_id", (q) => q.eq("workspace", workspace).eq("itemId", itemId)).unique();
    if (row) await ctx.db.patch(row._id, { json });
    else await ctx.db.insert("inbox", { workspace, itemId, trailId, json });
  },
});

export const inboxRemove = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), itemId: v.string() },
  handler: async (ctx, { workspace, secret, itemId }) => {
    requireSecret(secret);
    const row = await ctx.db.query("inbox")
      .withIndex("by_workspace_item_id", (q) => q.eq("workspace", workspace).eq("itemId", itemId)).unique();
    if (row) await ctx.db.delete(row._id);
  },
});

export const inboxGet = query({
  args: { workspace: v.optional(v.string()), secret: v.string(), itemId: v.string() },
  handler: async (ctx, { workspace, secret, itemId }) => {
    requireSecret(secret);
    const row = await ctx.db.query("inbox")
      .withIndex("by_workspace_item_id", (q) => q.eq("workspace", workspace).eq("itemId", itemId)).unique();
    return row?.json ?? null;
  },
});

export const inboxList = query({
  args: { workspace: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { workspace, secret }) => {
    requireSecret(secret);
    return (await ctx.db.query("inbox").withIndex("by_workspace", (q) => q.eq("workspace", workspace)).collect()).map((r) => r.json);
  },
});

// ───── jobs ─────
export const enqueue = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string(), kind: v.string(), payload: v.string(), runAtMs: v.number() },
  handler: async (ctx, { workspace, secret, key, kind, payload, runAtMs }) => {
    requireSecret(secret);
    const row = await ctx.db.query("jobs").withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (row) return false;
    await ctx.db.insert("jobs", { workspace, key, kind, payload, status: "queued", runAtMs, attempts: 0 });
    return true;
  },
});

/** Transactional claim: Convex mutations are serializable, so two workers never claim the same job. */
export const claim = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), nowMs: v.number(), limit: v.number() },
  handler: async (ctx, { workspace, secret, nowMs, limit }) => {
    requireSecret(secret);
    const due = await ctx.db.query("jobs")
      .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", "queued").lte("runAtMs", nowMs))
      .take(Math.max(0, Math.min(limit, 50)));
    for (const job of due) await ctx.db.patch(job._id, { status: "running", attempts: job.attempts + 1, startedMs: nowMs });
    return due.map((j) => ({ key: j.key, kind: j.kind, payload: j.payload, runAtMs: j.runAtMs, attempts: j.attempts + 1 }));
  },
});

/** Queued and running jobs, for the console's activity feed (bounded). */
export const activeJobs = query({
  args: { workspace: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { workspace, secret }) => {
    requireSecret(secret);
    const rows = [];
    for (const status of ["running", "queued"] as const) {
      rows.push(...await ctx.db.query("jobs")
        .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", status)).take(100));
    }
    return rows.map((j) => ({ key: j.key, kind: j.kind, payload: j.payload, status: j.status as "running" | "queued", runAtMs: j.runAtMs, startedMs: j.startedMs ?? null }));
  },
});

export const finish = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string() },
  handler: async (ctx, { workspace, secret, key }) => {
    requireSecret(secret);
    const row = await ctx.db.query("jobs").withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { status: "done" });
  },
});

export const fail = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string(), error: v.string(), runAtMs: v.number(), dead: v.boolean() },
  handler: async (ctx, { workspace, secret, key, error, runAtMs, dead }) => {
    requireSecret(secret);
    const row = await ctx.db.query("jobs").withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { status: dead ? "dead" : "queued", lastError: error.slice(0, 2000), runAtMs });
  },
});

export const deadJobs = query({
  args: { workspace: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { workspace, secret }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("jobs")
      .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", "dead")).take(100);
    return rows.map((r) => ({ key: r.key, kind: r.kind, error: r.lastError ?? "" }));
  },
});

/** Jobs left running by a crashed server go back to the queue on boot. */
export const recoverRunning = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { workspace, secret }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("jobs")
      .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", "running")).collect();
    for (const row of rows) await ctx.db.patch(row._id, { status: "queued" });
    return rows.length;
  },
});
