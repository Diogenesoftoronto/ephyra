// Composition root. Real implementations are wired here; nothing else in apps/server imports adapters.
// Postgres mode when DATABASE_URL is set, in-memory mode otherwise.
import { SQL } from "bun";
import { mkdir } from "node:fs/promises";
import { Hono } from "hono";
import {
  Unverified, transition, type Effect, type InboxItem, type SignalStore, type Trail, type TrailEvent,
  type TransitionContext,
} from "@ephyra/core";
import { MemorySignalStore, otlpRoutes } from "@ephyra/ingest";
import { GitJournal } from "@ephyra/journal";
import { AUTONOMY_TEMPLATE, checkpointMode, parseAutonomy } from "@ephyra/policy";
import type { Config } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { PgSignalStore } from "./db/pg-signal-store.ts";
import { createApp, type HttpPort } from "./http/app.ts";
import type { EffectHandlers, PolicyPort } from "./orchestrator.ts";

export const VERSION = "0.0.0-prealpha";

export type Composed = {
  app: Hono;
  mode: "memory" | "postgres";
  health(): Promise<{ db: "ok" | "unavailable" | "n/a" }>;
  close(): Promise<void>;
};

/** Effects whose adapters are not configured on this deployment fail into reconciliation (never crash). */
export function unconfiguredHandlers(): EffectHandlers {
  const fail = (name: string) => async () => { throw new Unverified(`${name} not configured on this deployment`); };
  const handlers = {} as Record<Effect["type"], () => Promise<void>>;
  const types: Effect["type"][] = [
    "run_triage", "start_agent", "run_proof", "request_checkpoint", "request_spend", "land", "rebase", "start_watch",
    "rollback", "register_regression_probe", "notify_inbox", "stop_agent", "merge_signal", "resume_dependents",
    "mute_fingerprint", "run_probes", "reply_comment", "start_respondent_run", "deliver_child_evidence",
  ];
  for (const type of types) handlers[type] = fail(type);
  return handlers as unknown as EffectHandlers;
}

/** Transition context from autonomy.md (shadow mode by default: every checkpoint blocks). */
export function policyPort(autonomyMd: string = AUTONOMY_TEMPLATE): PolicyPort {
  const policy = parseAutonomy(autonomyMd);
  return {
    async context(trail: Trail): Promise<TransitionContext> {
      const area = policy.areas.find((a) => a.name === trail.area);
      // Unknown area ⇒ conservative: every checkpoint blocks for a human.
      const blocking = (c: "A" | "B" | "C") => !area || checkpointMode(policy, area, c) === "blocking";
      return {
        now: new Date().toISOString(),
        blocking: { A: blocking("A"), B: blocking("B"), C: blocking("C") },
        landingModes: ["trail_ref"],
      };
    },
  };
}

/** Read-only HTTP port over the trail projection; mutating actions are not enabled until agents are wired. */
function readOnlyPort(sql: SQL | null): HttpPort {
  const notEnabled = async () => { throw new Unverified("trail actions are not enabled on this deployment yet"); };
  if (!sql) {
    return { inbox: async () => [], trails: async () => [], trail: async () => null, decide: notEnabled, action: notEnabled };
  }
  return {
    async inbox(): Promise<InboxItem[]> {
      const rows = await sql`SELECT item FROM inbox_items ORDER BY id`;
      return rows.map((r: { item: InboxItem }) => r.item);
    },
    async trails(state?: string): Promise<Trail[]> {
      const rows = state
        ? await sql`SELECT trail FROM trail_projection WHERE state = ${state} ORDER BY id`
        : await sql`SELECT trail FROM trail_projection ORDER BY id`;
      return rows.map((r: { trail: Trail }) => r.trail);
    },
    async trail(id: string) {
      const rows = await sql`SELECT trail FROM trail_projection WHERE id = ${id}`;
      if (!rows.length) return null;
      const events = await sql`SELECT event FROM event_inbox WHERE trail_id = ${id} ORDER BY id`;
      return { trail: rows[0].trail as Trail, events: events.map((e: { event: TrailEvent }) => e.event) };
    },
    decide: notEnabled,
    action: notEnabled,
  };
}

/** Token bucket per ingest key: at most `perMinute` OTLP requests per minute. */
function quota(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}

export async function compose(config: Config, env: Record<string, string | undefined> = process.env): Promise<Composed> {
  const sql = config.DATABASE_URL ? new SQL(config.DATABASE_URL) : null;
  if (sql) await migrate(sql);

  const signals: SignalStore = sql ? new PgSignalStore(sql) : new MemorySignalStore();
  const journalDir = env.EPHYRA_JOURNAL_DIR;
  if (journalDir) {
    await mkdir(journalDir, { recursive: true });
    const init = Bun.spawnSync(["git", "init", "--bare", "-q", journalDir]);
    if (init.exitCode !== 0) throw new Error("could not initialise the journal repository");
    // Constructed to validate the volume; the outbox publisher uses it once agents are wired.
    new GitJournal({ gitDir: journalDir, clock: { now: () => new Date() } });
  }
  void transition; void policyPort; void unconfiguredHandlers;

  const otlp = otlpRoutes({
    store: signals,
    onNewSignal: (s) => console.log(JSON.stringify({ msg: "new signal", fingerprint: s.fingerprint, service: s.service })),
    quota: quota(Number(env.EPHYRA_OTLP_PER_MINUTE ?? 600)),
    maxBodyBytes: Number(env.EPHYRA_OTLP_MAX_BYTES ?? 4_000_000),
  });
  const ingest = new Hono();
  // OTLP is authenticated with the same bearer token as the API.
  ingest.use("*", async (c, next) => {
    const ok = c.req.header("Authorization") === `Bearer ${config.EPHYRA_API_TOKEN}`;
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  ingest.route("/", otlp);

  const mode = sql ? "postgres" : "memory";
  const health = async () => {
    if (!sql) return { db: "n/a" as const };
    try { await sql`SELECT 1`; return { db: "ok" as const }; } catch { return { db: "unavailable" as const }; }
  };
  const api = createApp(config.EPHYRA_API_TOKEN, readOnlyPort(sql), ingest);
  const app = new Hono();
  app.get("/healthz", async (c) => {
    const h = await health();
    return c.json({ ok: h.db !== "unavailable", mode, ...h, version: VERSION }, h.db === "unavailable" ? 503 : 200);
  });
  app.route("/", api);
  return { app, mode, health, close: async () => { await sql?.close(); } };
}
