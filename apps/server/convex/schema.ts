// Ephyra's durable state in Convex. Payloads are stored as JSON strings (validated with zod on the server)
// so arbitrary keys from telemetry never collide with Convex field-name rules; indexed columns are scalars.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  signals: defineTable({
    signalId: v.string(),
    fingerprint: v.string(),
    json: v.string(),
    firstSeenMs: v.number(),
    /** File of the first in-app stack frame, for "new fingerprint in touched files". */
    topInAppFile: v.optional(v.string()),
  })
    .index("by_fingerprint", ["fingerprint"])
    .index("by_signal_id", ["signalId"])
    .index("by_file_first_seen", ["topInAppFile", "firstSeenMs"]),

  occurrences: defineTable({ fingerprint: v.string(), atMs: v.number(), count: v.number() })
    .index("by_fingerprint_at", ["fingerprint", "atMs"]),

  /** Per-route, per-minute request/error counts for error-rate baselines. */
  requestBuckets: defineTable({ route: v.string(), minuteMs: v.number(), requests: v.number(), errors: v.number() })
    .index("by_route_minute", ["route", "minuteMs"]),

  mutes: defineTable({ fingerprint: v.string(), untilMs: v.number() }).index("by_fingerprint", ["fingerprint"]),

  trails: defineTable({ trailId: v.string(), state: v.string(), json: v.string(), updatedMs: v.number() })
    .index("by_trail_id", ["trailId"])
    .index("by_state", ["state"]),

  events: defineTable({ eventId: v.string(), trailId: v.string(), json: v.string() })
    .index("by_event_id", ["eventId"])
    .index("by_trail", ["trailId"]),

  inbox: defineTable({ itemId: v.string(), trailId: v.string(), json: v.string() })
    .index("by_item_id", ["itemId"])
    .index("by_trail", ["trailId"]),

  jobs: defineTable({
    key: v.string(),
    kind: v.string(),
    payload: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("dead")),
    runAtMs: v.number(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_key", ["key"])
    .index("by_status_run_at", ["status", "runAtMs"]),

  /** Operation ledger: one row per effect key, so a replay never repeats a side effect. */
  operations: defineTable({
    key: v.string(),
    planDigest: v.string(),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("reconciliation_required")),
    result: v.optional(v.string()),
    at: v.string(),
  }).index("by_key", ["key"]),

  reconciliations: defineTable({ key: v.string(), note: v.string(), at: v.string() }).index("by_key", ["key"]),

  /** Not Organic sign-in: pending logins (single use, short-lived). */
  authTx: defineTable({ state: v.string(), json: v.string(), createdMs: v.number() }).index("by_state", ["state"]),
  /** Sessions keyed by SHA-256 of the session token; secrets inside `json` are sealed by the server. */
  sessions: defineTable({
    sessionHash: v.string(), did: v.string(), json: v.string(), version: v.number(), createdMs: v.number(), expiresMs: v.number(),
  })
    .index("by_hash", ["sessionHash"])
    .index("by_did_created", ["did", "createdMs"]),
  /** CLI sign-in grants, released once to the CLI holding the challenge preimage after browser approval. */
  cliGrants: defineTable({ challenge: v.string(), json: v.string(), approved: v.boolean(), createdMs: v.number() })
    .index("by_challenge", ["challenge"]),

  usage: defineTable({ key: v.string(), json: v.string() }).index("by_key", ["key"]),

  /** Hash-chained audit log; the chain is extended inside a serializable mutation. */
  audit: defineTable({ seq: v.number(), auditId: v.string(), json: v.string(), prevHash: v.string(), hash: v.string() })
    .index("by_seq", ["seq"])
    .index("by_audit_id", ["auditId"]),
});
