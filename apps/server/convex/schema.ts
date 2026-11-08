// Ephyra's durable state in Convex. Payloads are stored as JSON strings (validated with zod on the server)
// so arbitrary keys from telemetry never collide with Convex field-name rules; indexed columns are scalars.
// Undefined workspace is the legacy namespace. Keep its old indexes for additive deployment, but project
// functions always use a workspace-prefixed index, including when reading legacy rows.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  signals: defineTable({
    workspace: v.optional(v.string()),
    signalId: v.string(),
    fingerprint: v.string(),
    json: v.string(),
    firstSeenMs: v.number(),
    /** File of the first in-app stack frame, for "new fingerprint in touched files". */
    topInAppFile: v.optional(v.string()),
  })
    .index("by_workspace", ["workspace"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_workspace_fingerprint", ["workspace", "fingerprint"])
    .index("by_signal_id", ["signalId"])
    .index("by_workspace_signal_id", ["workspace", "signalId"])
    .index("by_file_first_seen", ["topInAppFile", "firstSeenMs"])
    .index("by_workspace_file_first_seen", ["workspace", "topInAppFile", "firstSeenMs"]),

  occurrences: defineTable({
    workspace: v.optional(v.string()),
    fingerprint: v.string(),
    atMs: v.number(),
    count: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_fingerprint_at", ["fingerprint", "atMs"])
    .index("by_workspace_fingerprint_at", ["workspace", "fingerprint", "atMs"]),

  /** Per-route, per-minute request/error counts for error-rate baselines. */
  requestBuckets: defineTable({
    workspace: v.optional(v.string()),
    route: v.string(),
    minuteMs: v.number(),
    requests: v.number(),
    errors: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_route_minute", ["route", "minuteMs"])
    .index("by_workspace_route_minute", ["workspace", "route", "minuteMs"]),

  mutes: defineTable({
    workspace: v.optional(v.string()),
    fingerprint: v.string(),
    untilMs: v.number(),
  }).index("by_workspace", ["workspace"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_workspace_fingerprint", ["workspace", "fingerprint"]),

  trails: defineTable({
    workspace: v.optional(v.string()),
    trailId: v.string(),
    state: v.string(),
    json: v.string(),
    updatedMs: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_trail_id", ["trailId"])
    .index("by_workspace_trail_id", ["workspace", "trailId"])
    .index("by_state", ["state"])
    .index("by_workspace_state", ["workspace", "state"]),

  events: defineTable({
    workspace: v.optional(v.string()),
    eventId: v.string(),
    trailId: v.string(),
    json: v.string(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_event_id", ["eventId"])
    .index("by_workspace_event_id", ["workspace", "eventId"])
    .index("by_trail", ["trailId"])
    .index("by_workspace_trail", ["workspace", "trailId"]),

  inbox: defineTable({
    workspace: v.optional(v.string()),
    itemId: v.string(),
    trailId: v.string(),
    json: v.string(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_item_id", ["itemId"])
    .index("by_workspace_item_id", ["workspace", "itemId"])
    .index("by_trail", ["trailId"])
    .index("by_workspace_trail", ["workspace", "trailId"]),

  jobs: defineTable({
    workspace: v.optional(v.string()),
    key: v.string(),
    kind: v.string(),
    payload: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("dead")),
    runAtMs: v.number(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    /** When the current attempt was claimed; shown as "running since" in the activity feed. */
    startedMs: v.optional(v.number()),
    ownerId: v.optional(v.string()),
    ownerFence: v.optional(v.number()),
    claimId: v.optional(v.string()),
  })
    .index("by_workspace", ["workspace"])
    .index("by_key", ["key"])
    .index("by_workspace_key", ["workspace", "key"])
    .index("by_status_run_at", ["status", "runAtMs"])
    .index("by_workspace_status_run_at", ["workspace", "status", "runAtMs"]),

  /** One fenced background-worker owner per workspace; HTTP replicas may remain followers. */
  runtimeWorkers: defineTable({
    workspace: v.optional(v.string()), ownerId: v.string(), fence: v.number(), expiresMs: v.number(),
  }).index("by_workspace", ["workspace"]),

  /** Operation ledger: one row per effect key, so a replay never repeats a side effect. */
  operations: defineTable({
    workspace: v.optional(v.string()),
    key: v.string(),
    planDigest: v.string(),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("reconciliation_required")),
    result: v.optional(v.string()),
    at: v.string(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_key", ["key"])
    .index("by_workspace_key", ["workspace", "key"]),

  reconciliations: defineTable({
    workspace: v.optional(v.string()),
    key: v.string(),
    note: v.string(),
    at: v.string(),
  }).index("by_workspace", ["workspace"])
    .index("by_key", ["key"])
    .index("by_workspace_key", ["workspace", "key"]),

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

  /** Account settings belong to the authenticated DID, independently of any selected project workspace. */
  accountSettings: defineTable({ did: v.string(), version: v.number(), json: v.string() })
    .index("by_did", ["did"]),
  accountOperations: defineTable({
    did: v.string(),
    key: v.string(),
    digest: v.string(),
    expectedVersion: v.number(),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index("by_did_key", ["did", "key"]),

  usage: defineTable({
    workspace: v.optional(v.string()),
    key: v.string(),
    json: v.string(),
  }).index("by_workspace", ["workspace"])
    .index("by_key", ["key"])
    .index("by_workspace_key", ["workspace", "key"]),

  /** Agent runs (one per agent step): the run record, and its normalized event stream with a per-run monotonic seq. */
  runs: defineTable({
    workspace: v.optional(v.string()),
    runId: v.string(),
    trailId: v.optional(v.string()),
    status: v.string(),
    startedMs: v.number(),
    json: v.string(),
    ownerId: v.optional(v.string()),
    ownerFence: v.optional(v.number()),
  })
    .index("by_workspace", ["workspace"])
    .index("by_run_id", ["runId"])
    .index("by_workspace_run_id", ["workspace", "runId"])
    .index("by_status_started", ["status", "startedMs"])
    .index("by_workspace_status_started", ["workspace", "status", "startedMs"])
    .index("by_trail_started", ["trailId", "startedMs"])
    .index("by_workspace_trail_started", ["workspace", "trailId", "startedMs"])
    .index("by_started", ["startedMs"])
    .index("by_workspace_started", ["workspace", "startedMs"]),
  runEvents: defineTable({
    workspace: v.optional(v.string()),
    runId: v.string(),
    seq: v.number(),
    json: v.string(),
  }).index("by_workspace", ["workspace"])
    .index("by_run_seq", ["runId", "seq"])
    .index("by_workspace_run_seq", ["workspace", "runId", "seq"]),

  /** Console policy drafts: the full Draft JSON, indexed by id and status. */
  drafts: defineTable({
    workspace: v.optional(v.string()),
    draftId: v.string(),
    status: v.string(),
    json: v.string(),
    updatedMs: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_draft_id", ["draftId"])
    .index("by_workspace_draft_id", ["workspace", "draftId"])
    .index("by_status_updated", ["status", "updatedMs"])
    .index("by_workspace_status_updated", ["workspace", "status", "updatedMs"]),

  /** Hash-chained audit log; the chain is extended inside a serializable mutation. */
  audit: defineTable({
    workspace: v.optional(v.string()),
    seq: v.number(),
    auditId: v.string(),
    json: v.string(),
    prevHash: v.string(),
    hash: v.string(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_seq", ["seq"])
    .index("by_workspace_seq", ["workspace", "seq"])
    .index("by_audit_id", ["auditId"])
    .index("by_workspace_audit_id", ["workspace", "auditId"]),
});
