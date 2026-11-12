import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Journal, Signal } from "@ephyra/core";
import { TelemetryProviderEvidence, type TelemetryObservation } from "@ephyra/evidence";
import { MemorySignalStore } from "@ephyra/ingest";
import { FakeContext, type ServerContext } from "../wiring/context";
import { MemoryOperationLedger } from "../orchestrator/effects";
import { providerSignal, registerProviderPolling } from "./provider-polling";
const now = new Date("2026-11-12T12:00:00Z");
const batch: TelemetryObservation = { source: "telemetry:test", coverage: "partial", limitations: ["sample only"], retrievedAt: now.toISOString(),
  events: [{ id: "event", timestamp: now.toISOString(), message: "Failure", level: "error", fingerprint: "issue", attributes: {} }] };
test("signal identity separates workspaces and sources and never invents healthy coverage", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 50 }), (repo) => {
    const a = providerSignal(repo, batch, batch.events[0]!);
    expect(a).toEqual(providerSignal(repo, batch, batch.events[0]!));
    expect(a.id).not.toBe(providerSignal(repo + "x", batch, batch.events[0]!).id);
    expect(a.environment).toBe("unknown"); expect(a.attributes["telemetry.health"]).toBe("not_established");
  }));
});
test("poll claims deduplicate and revocation stops further intake and scheduling", async () => {
  let allowed = true;
  const source = new TelemetryProviderEvidence({ connection: { id: "logs", provider: "datadog", origin: "https://api.datadoghq.com", project: "web" },
    scope: { accountId: "did:alice", workspaceId: "ws" }, now: () => now, authorize: async () => allowed,
    credential: async () => ({ apiKey: "secret", applicationKey: "app-secret" }),
    fetcher: async () => Response.json({ data: [{ id: "log1", attributes: { timestamp: now.toISOString(), message: "Failure", status: "error" } }] }) });
  const signals = new MemorySignalStore();
  const ctx = new FakeContext({ id: "repo", url: "https://git.example.org/app", mirrorDir: "/tmp/unused", baseRef: "main", forge: "plain", remote: "origin" },
    {} as ServerContext["policy"], {} as Journal, signals, { now: () => now });
  const sent: Signal[] = [];
  const polling = registerProviderPolling({ ctx, ledger: new MemoryOperationLedger(), resolve: async () => allowed ? [source] : [],
    onSignal: async (signal) => { sent.push(signal); } });
  await polling.poll(source.name); await polling.poll(source.name);
  expect(sent).toHaveLength(1);
  await polling.start(); expect(ctx.queued).toHaveLength(1);
  allowed = false;
  const job = ctx.queued.shift()!;
  await ctx.jobRunners.get(job.kind)!(job.payload, { key: job.key, attempt: 1 });
  expect(ctx.queued).toHaveLength(0);
  await polling.poll(source.name); expect(sent).toHaveLength(1);
});
