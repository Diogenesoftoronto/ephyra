import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { migrate } from "./migrate.ts";
import { PgOperationLedger } from "./pg-operation-ledger.ts";
import { PgSignalStore } from "./pg-signal-store.ts";

const enabled = process.env.EPHYRA_PG === "1";
let directory = "";
let sql: SQL;
let started = false;

async function command(args: string[]): Promise<void> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args[0]} failed: ${await new Response(proc.stderr).text()}`);
}

beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "ephyra-pg-"));
  await command(["initdb", "-D", directory, "-A", "trust", "-U", "postgres"]);
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });
  await command(["pg_ctl", "-D", directory, "-l", join(directory, "log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory}`, "-w", "start"]);
  started = true;
  sql = new SQL(`postgres://postgres@127.0.0.1:${port}/postgres`);
  await migrate(sql);
  await migrate(sql);
}, 30000);

afterAll(async () => {
  if (!enabled || !directory) return;
  if (sql) await sql.close();
  if (started) await command(["pg_ctl", "-D", directory, "-m", "fast", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}, 30000);

test.skipIf(!enabled)("postgres ledger and signals persist", async () => {
  const ledger = new PgOperationLedger(sql);
  expect(await ledger.begin("k", "digest")).toEqual({ fresh: true });
  await ledger.complete("k", { ok: true });
  expect((await ledger.get("k"))?.status).toBe("done");
  await expect(ledger.begin("k", "other")).rejects.toThrow();
  const store = new PgSignalStore(sql);
  const signal = {
    schema: 1 as const, id: crypto.randomUUID(), kind: "error" as const, repo: "r", environment: "production",
    fingerprint: "fingerprint", title: "error", message: "error", frames: [], firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-01T00:00:00Z", count: 1, attributes: {}, source: "test",
  };
  expect((await store.upsert(signal)).isNew).toBe(true);
  expect((await store.upsert({ ...signal, id: crypto.randomUUID() })).signal.count).toBe(2);
  expect(await store.countSince(signal.fingerprint, new Date("2025-01-01"))).toBe(2);
});

test.skipIf(!enabled)("postgres outbox publishes before dispatch and deduplicates", async () => {
  const { PgOrchestrator } = await import("./pg-orchestrator.ts");
  const { EffectExecutor, MemoryOperationLedger } = await import("../orchestrator/effects.ts");
  const { Trail, TrailEvent } = await import("@ephyra/core");
  const at = "2026-01-01T00:00:00Z";
  const trail = Trail.parse({
    schema: 1, id: crypto.randomUUID(), short: "T-test", repo: "r", title: "t", rev: 1, state: "sensed",
    signals: [], area: "a", risk: "low", route: "auto_fix", severity: 1, base: { ref: "main", sha: "a".repeat(40) },
    checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 1 },
    budget: { tokensUsed: 0, tokensMax: 1, wallclockMaxS: 1, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
    mirrors: {}, createdAt: at, updatedAt: at,
  });
  const event = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: trail.id, rev: 1, at,
    actor: { kind: "system", id: "test" }, type: "new_signal", data: { signalId: crypto.randomUUID() } });
  let acknowledged = false;
  let calls = 0;
  const handlers = { stop_agent: async () => { expect(acknowledged).toBe(true); calls++; } };
  const executor = new EffectExecutor(new MemoryOperationLedger(), handlers as never, { record: async () => {} });
  const journal = {
    read: async () => null,
    create: async () => { acknowledged = true; return "head"; },
  } as unknown as import("@ephyra/core").Journal;
  const policy = { context: async () => ({ now: at, blocking: { A: true, B: true, C: true }, landingModes: [] }) };
  const orchestrator = new PgOrchestrator(sql, (t) => ({ ok: true, trail: t,
    effects: [{ type: "stop_agent", key: "test-effect", releaseLease: true }] }), policy, journal, executor);
  await orchestrator.seed(trail);
  await orchestrator.apply(event);
  await orchestrator.apply(event);
  expect(calls).toBe(0);
  await orchestrator.publish(event.id);
  await orchestrator.publish(event.id);
  expect(calls).toBe(1);
});
