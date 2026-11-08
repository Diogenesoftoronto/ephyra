// Trail projection, event log, inbox and job queue (RuntimeStore in apps/server/src/wiring/store.ts).
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";
import { currentWorker, leaseDuration, ownsWorker, requireWorker, workerIdentity } from "./worker_owner";

/** Acquisition is exclusive within one namespace. Replaying a live acquisition never extends its deadline. */
export const registerWorker = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), ownerId: v.string(), ttlMs: v.number() },
  handler: async (ctx, { workspace, secret, ownerId, ttlMs }) => {
    requireSecret(secret); workerIdentity(ownerId); leaseDuration(ttlMs);
    const now = Date.now(), previous = await currentWorker(ctx, workspace);
    if (previous && previous.expiresMs > now) return { active: previous.ownerId === ownerId,
      fence: previous.fence, expiresMs: previous.expiresMs, serverNowMs: now };
    const fence = (previous?.fence ?? 0) + 1, expiresMs = now + ttlMs;
    if (!Number.isSafeInteger(fence)) throw new Error("Worker fence exhausted");
    if (previous) await ctx.db.patch(previous._id, { ownerId, fence, expiresMs });
    else await ctx.db.insert("runtimeWorkers", { workspace, ownerId, fence, expiresMs });
    return { active: true, fence, expiresMs, serverNowMs: now };
  },
});

export const heartbeatWorker = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), ownerId: v.string(), fence: v.number(), ttlMs: v.number() },
  handler: async (ctx, { workspace, secret, ownerId, fence, ttlMs }) => {
    requireSecret(secret); leaseDuration(ttlMs);
    const now = Date.now(), previous = await currentWorker(ctx, workspace);
    if (!previous || previous.ownerId !== ownerId || previous.fence !== fence || previous.expiresMs <= now)
      return { active: false, fence, expiresMs: 0, serverNowMs: now };
    const expiresMs = now + ttlMs;
    await ctx.db.patch(previous._id, { expiresMs });
    return { active: true, fence, expiresMs, serverNowMs: now };
  },
});

export const releaseWorker = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), ownerId: v.string(), fence: v.number() },
  handler: async (ctx, { workspace, secret, ownerId, fence }) => {
    requireSecret(secret);
    const previous = await currentWorker(ctx, workspace);
    if (!previous || previous.ownerId !== ownerId || previous.fence !== fence) return false;
    await ctx.db.patch(previous._id, { expiresMs: 0 });
    return true;
  },
});

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
  args: { workspace: v.optional(v.string()), secret: v.string(), trailId: v.string(), state: v.string(), json: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, trailId, state, json, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
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
  args: { workspace: v.optional(v.string()), secret: v.string(), eventId: v.string(), trailId: v.string(), json: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, eventId, trailId, json, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
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
  args: { workspace: v.optional(v.string()), secret: v.string(), itemId: v.string(), trailId: v.string(), json: v.string(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, itemId, trailId, json, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
    const row = await ctx.db.query("inbox")
      .withIndex("by_workspace_item_id", (q) => q.eq("workspace", workspace).eq("itemId", itemId)).unique();
    if (row) await ctx.db.patch(row._id, { json });
    else await ctx.db.insert("inbox", { workspace, itemId, trailId, json });
  },
});

export const inboxRemove = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), itemId: v.string(), ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, itemId, ownerId, fence }) => {
    requireSecret(secret); await requireWorker(ctx, workspace, { ownerId, fence });
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
  args: { workspace: v.optional(v.string()), secret: v.string(), nowMs: v.number(), limit: v.number(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, nowMs, limit, ownerId, fence }) => {
    requireSecret(secret);
    // Old binaries remain API-compatible during a rolling deploy, but cannot claim unowned work.
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return [];
    const due = await ctx.db.query("jobs")
      .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", "queued").lte("runAtMs", nowMs))
      .take(Math.max(0, Math.min(limit, 50)));
    const result = [];
    for (const job of due) {
      const attempts = job.attempts + 1, claimId = `${ownerId}:${fence}:${attempts}`;
      await ctx.db.patch(job._id, { status: "running", attempts, startedMs: Date.now(), ownerId, ownerFence: fence, claimId });
      result.push({ key: job.key, kind: job.kind, payload: job.payload, runAtMs: job.runAtMs, attempts, claimId });
    }
    return result;
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
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string(), ownerId: v.optional(v.string()),
    fence: v.optional(v.number()), claimId: v.optional(v.string()) },
  handler: async (ctx, { workspace, secret, key, ownerId, fence, claimId }) => {
    requireSecret(secret);
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return false;
    const row = await ctx.db.query("jobs").withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (!row || row.ownerId !== ownerId || row.ownerFence !== fence || row.claimId !== claimId) return false;
    if (row.status === "done") return true;
    if (row.status !== "running") return false;
    await ctx.db.patch(row._id, { status: "done" });
    return true;
  },
});

export const fail = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), key: v.string(), error: v.string(), runAtMs: v.number(), dead: v.boolean(),
    ownerId: v.optional(v.string()), fence: v.optional(v.number()), claimId: v.optional(v.string()) },
  handler: async (ctx, { workspace, secret, key, error, runAtMs, dead, ownerId, fence, claimId }) => {
    requireSecret(secret);
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return false;
    const row = await ctx.db.query("jobs").withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key)).unique();
    if (!row || row.status !== "running" || row.ownerId !== ownerId || row.ownerFence !== fence || row.claimId !== claimId) return false;
    await ctx.db.patch(row._id, { status: dead ? "dead" : "queued", lastError: error.slice(0, 2000), runAtMs });
    return true;
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

/** A dead worker's external outcome is uncertain. Reconcile it instead of allocating a replacement automatically. */
export const recoverRunning = mutation({
  args: { workspace: v.optional(v.string()), secret: v.string(), ownerId: v.optional(v.string()), fence: v.optional(v.number()) },
  handler: async (ctx, { workspace, secret, ownerId, fence }) => {
    requireSecret(secret);
    if (!await ownsWorker(ctx, workspace, { ownerId, fence })) return 0;
    const rows = await ctx.db.query("jobs")
      .withIndex("by_workspace_status_run_at", (q) => q.eq("workspace", workspace).eq("status", "running")).collect();
    let recovered = 0;
    for (const row of rows) {
      if (row.ownerId === ownerId && row.ownerFence === fence) continue;
      await ctx.db.patch(row._id, { status: "dead", lastError:
        "Previous worker ownership ended before completion. External operations require reconciliation; this job was not restarted." });
      recovered++;
    }
    return recovered;
  },
});
