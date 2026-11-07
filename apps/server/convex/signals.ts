// SignalStore backing (packages/core ports.ts). The server validates Signal JSON with zod before calling.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { MINUTE_MS, requireSecret } from "./lib";

type SignalJson = { id: string; fingerprint: string; count: number; firstSeen: string; lastSeen: string };

export const upsert = mutation({
  args: { secret: v.string(), json: v.string(), topInAppFile: v.optional(v.string()) },
  handler: async (ctx, { secret, json, topInAppFile }) => {
    requireSecret(secret);
    const incoming = JSON.parse(json) as SignalJson;
    const existing = await ctx.db.query("signals")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", incoming.fingerprint)).unique();
    let stored: SignalJson;
    if (existing) {
      const prior = JSON.parse(existing.json) as SignalJson;
      stored = {
        ...prior,
        count: prior.count + incoming.count,
        lastSeen: prior.lastSeen > incoming.lastSeen ? prior.lastSeen : incoming.lastSeen,
        firstSeen: prior.firstSeen < incoming.firstSeen ? prior.firstSeen : incoming.firstSeen,
      };
      await ctx.db.patch(existing._id, { json: JSON.stringify(stored), firstSeenMs: Date.parse(stored.firstSeen) });
    } else {
      stored = incoming;
      await ctx.db.insert("signals", {
        signalId: incoming.id, fingerprint: incoming.fingerprint, json,
        firstSeenMs: Date.parse(incoming.firstSeen), topInAppFile,
      });
    }
    await ctx.db.insert("occurrences", {
      fingerprint: incoming.fingerprint, atMs: Date.parse(incoming.lastSeen), count: incoming.count,
    });
    return { json: JSON.stringify(stored), isNew: !existing };
  },
});

export const get = query({
  args: { secret: v.string(), signalId: v.string() },
  handler: async (ctx, { secret, signalId }) => {
    requireSecret(secret);
    const row = await ctx.db.query("signals").withIndex("by_signal_id", (q) => q.eq("signalId", signalId)).unique();
    return row?.json ?? null;
  },
});

export const byFingerprint = query({
  args: { secret: v.string(), fingerprint: v.string() },
  handler: async (ctx, { secret, fingerprint }) => {
    requireSecret(secret);
    const row = await ctx.db.query("signals").withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint)).unique();
    return row?.json ?? null;
  },
});

export const countSince = query({
  args: { secret: v.string(), fingerprint: v.string(), sinceMs: v.number() },
  handler: async (ctx, { secret, fingerprint, sinceMs }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("occurrences")
      .withIndex("by_fingerprint_at", (q) => q.eq("fingerprint", fingerprint).gte("atMs", sinceMs)).collect();
    return rows.reduce((n, r) => n + r.count, 0);
  },
});

export const newInFiles = query({
  args: { secret: v.string(), files: v.array(v.string()), sinceMs: v.number() },
  handler: async (ctx, { secret, files, sinceMs }) => {
    requireSecret(secret);
    const out: string[] = [];
    for (const file of new Set(files)) {
      const rows = await ctx.db.query("signals")
        .withIndex("by_file_first_seen", (q) => q.eq("topInAppFile", file).gte("firstSeenMs", sinceMs)).collect();
      out.push(...rows.map((r) => r.json));
    }
    return out;
  },
});

export const recordRequest = mutation({
  args: { secret: v.string(), route: v.string(), atMs: v.number(), error: v.boolean() },
  handler: async (ctx, { secret, route, atMs, error }) => {
    requireSecret(secret);
    const minuteMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const bucket = await ctx.db.query("requestBuckets")
      .withIndex("by_route_minute", (q) => q.eq("route", route).eq("minuteMs", minuteMs)).unique();
    if (bucket) await ctx.db.patch(bucket._id, { requests: bucket.requests + 1, errors: bucket.errors + (error ? 1 : 0) });
    else await ctx.db.insert("requestBuckets", { route, minuteMs, requests: 1, errors: error ? 1 : 0 });
  },
});

export const errorRate = query({
  args: { secret: v.string(), route: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (ctx, { secret, route, fromMs, toMs }) => {
    requireSecret(secret);
    const rows = await ctx.db.query("requestBuckets")
      .withIndex("by_route_minute", (q) => q.eq("route", route).gte("minuteMs", fromMs).lt("minuteMs", toMs)).collect();
    if (!rows.length) return null;
    return { requests: rows.reduce((n, r) => n + r.requests, 0), errors: rows.reduce((n, r) => n + r.errors, 0) };
  },
});

export const mute = mutation({
  args: { secret: v.string(), fingerprint: v.string(), untilMs: v.number() },
  handler: async (ctx, { secret, fingerprint, untilMs }) => {
    requireSecret(secret);
    const row = await ctx.db.query("mutes").withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint)).unique();
    if (row) await ctx.db.patch(row._id, { untilMs });
    else await ctx.db.insert("mutes", { fingerprint, untilMs });
  },
});

export const isMuted = query({
  args: { secret: v.string(), fingerprint: v.string(), atMs: v.number() },
  handler: async (ctx, { secret, fingerprint, atMs }) => {
    requireSecret(secret);
    const row = await ctx.db.query("mutes").withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint)).unique();
    return (row?.untilMs ?? 0) > atMs;
  },
});
