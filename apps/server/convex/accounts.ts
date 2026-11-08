// DID-owned account settings and idempotent update receipts. Credential strings are sealed by the server
// before reaching these functions. Every endpoint requires the server's shared secret.
import { AccountSettings } from "@ephyra/core";
import { v } from "convex/values";
import { z } from "zod";
import { mutation, query } from "./_generated/server";
import { requireSecret } from "./lib";
import { TeamRecord } from "../src/setup/team-record";

const accountRecord = z
  .object({
    settings: AccountSettings,
    modelKey: z.string().optional(),
    repoToken: z.string().optional(),
    team: TeamRecord.optional(),
    telemetryKey: z.string().optional(),
    peopleToken: z.string().optional(),
  })
  .strict();

type BeginResult =
  | { status: "fresh" }
  | { status: "completed"; json: string }
  | { status: "failed"; error: string }
  | { status: "pending" | "conflict" };

export const ensure = mutation({
  args: { secret: v.string(), did: v.string(), json: v.string() },
  handler: async (ctx, { secret, did, json }) => {
    requireSecret(secret);
    const record = accountRecord.parse(JSON.parse(json));
    if (record.settings.did !== did) throw new Error("account owner mismatch");
    const existing = await ctx.db
      .query("accountSettings")
      .withIndex("by_did", (q) => q.eq("did", did))
      .unique();
    if (existing) return existing.json;
    const stored = JSON.stringify(record);
    await ctx.db.insert("accountSettings", { did, version: record.settings.version, json: stored });
    return stored;
  },
});

export const get = query({
  args: { secret: v.string(), did: v.string() },
  handler: async (ctx, { secret, did }) => {
    requireSecret(secret);
    return (
      (
        await ctx.db
          .query("accountSettings")
          .withIndex("by_did", (q) => q.eq("did", did))
          .unique()
      )?.json ?? null
    );
  },
});

/** Internal control-plane enumeration; never expose this list through an unauthenticated route. */
export const list = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireSecret(secret);
    return (await ctx.db.query("accountSettings").collect()).map((row) => row.json);
  },
});

export const begin = mutation({
  args: { secret: v.string(), did: v.string(), key: v.string(), digest: v.string(), expectedVersion: v.number() },
  handler: async (ctx, { secret, did, key, digest, expectedVersion }): Promise<BeginResult> => {
    requireSecret(secret);
    const operation = await ctx.db
      .query("accountOperations")
      .withIndex("by_did_key", (q) => q.eq("did", did).eq("key", key))
      .unique();
    if (operation) {
      if (operation.digest !== digest) return { status: "conflict" };
      if (operation.status === "completed") {
        if (operation.result === undefined) throw new Error("account receipt is missing");
        return { status: "completed", json: operation.result };
      }
      if (operation.status === "failed")
        return { status: "failed", error: operation.error ?? "Account update failed." };
      return { status: "pending" };
    }
    const account = await ctx.db
      .query("accountSettings")
      .withIndex("by_did", (q) => q.eq("did", did))
      .unique();
    if (!account || account.version !== expectedVersion) return { status: "conflict" };
    await ctx.db.insert("accountOperations", { did, key, digest, expectedVersion, status: "pending" });
    return { status: "fresh" };
  },
});

/** Settings and the successful receipt commit together, after the reserved version still matches. */
export const complete = mutation({
  args: { secret: v.string(), did: v.string(), key: v.string(), digest: v.string(), json: v.string() },
  handler: async (ctx, { secret, did, key, digest, json }) => {
    requireSecret(secret);
    const record = accountRecord.parse(JSON.parse(json));
    if (record.settings.did !== did) return false;
    const operation = await ctx.db
      .query("accountOperations")
      .withIndex("by_did_key", (q) => q.eq("did", did).eq("key", key))
      .unique();
    if (!operation || operation.status !== "pending" || operation.digest !== digest) return false;
    if (record.settings.version !== operation.expectedVersion + 1) return false;
    const account = await ctx.db
      .query("accountSettings")
      .withIndex("by_did", (q) => q.eq("did", did))
      .unique();
    if (!account || account.version !== operation.expectedVersion) return false;
    const previous = accountRecord.parse(JSON.parse(account.json));
    if (previous.settings.workspaceId !== record.settings.workspaceId) delete record.team;
    const stored = JSON.stringify(record);
    await ctx.db.patch(account._id, { version: record.settings.version, json: stored });
    await ctx.db.patch(operation._id, { status: "completed", result: JSON.stringify({ settings: record.settings }) });
    return true;
  },
});

/** Only a matching pending operation may fail; a late failure cannot rewrite a successful receipt. */
export const fail = mutation({
  args: { secret: v.string(), did: v.string(), key: v.string(), digest: v.string(), error: v.string() },
  handler: async (ctx, { secret, did, key, digest, error }) => {
    requireSecret(secret);
    const operation = await ctx.db
      .query("accountOperations")
      .withIndex("by_did_key", (q) => q.eq("did", did).eq("key", key))
      .unique();
    if (!operation || operation.status !== "pending" || operation.digest !== digest) return;
    await ctx.db.patch(operation._id, { status: "failed", error });
  },
});
