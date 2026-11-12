import { createHash } from "node:crypto";
import { Signal, type OperationLedger } from "@ephyra/core";
import type { TelemetryProviderEvidence, TelemetryObservation } from "@ephyra/evidence";
import { redact } from "@ephyra/ingest";
import type { ServerContext } from "../wiring/context.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function providerSignal(repo: string, batch: TelemetryObservation, event: TelemetryObservation["events"][number]): Signal {
  const bytes = Buffer.from(hash([repo, batch.source, event.id]).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  const message = redact(event.message).slice(0, 8000);
  return Signal.parse({ schema: 1, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    kind: "error", repo, source: batch.source, environment: "unknown",
    fingerprint: `provider:${hash([repo, batch.source, event.fingerprint ?? message])}`,
    title: (message || "Recorded telemetry event").slice(0, 300), message, frames: [],
    firstSeen: event.timestamp, lastSeen: event.timestamp, count: 1,
    attributes: { ...event.attributes, "telemetry.event_id": event.id, "telemetry.coverage": batch.coverage,
      "telemetry.retrieved_at": batch.retrievedAt, "telemetry.health": "not_established" } });
}

/** Bounded polling with durable operation claims. A partial query is never evidence of a quiet production window. */
export function registerProviderPolling(options: { ctx: ServerContext; ledger: OperationLedger;
  resolve: () => Promise<TelemetryProviderEvidence[]>; onSignal: (signal: Signal) => Promise<void>; onObservation?: () => Promise<void> }) {
  const { ctx, ledger } = options;
  let stopped = false;
  const observations = new Map<string, { at: number; batch: TelemetryObservation; source: TelemetryProviderEvidence }>();
  const current = async (name: string) => !stopped && (await options.resolve()).find((source) => source.name === name);
  const poll = async (name: string) => {
    const source = await current(name);
    if (!source) return;
    const batch = await source.observe(new Date(ctx.clock.now().getTime() - 5 * 60_000).toISOString());
    for (const event of batch.events) {
      await source.assertAuthorized();
      if (!await current(name)) return;
      const signal = providerSignal(ctx.repo.id, batch, event);
      const key = `telemetry-event:${hash([ctx.repo.id, name, event.id])}`;
      const claim = await ledger.begin(key, hash(["telemetry-intake-v1", ctx.repo.id, name, event.id]));
      if (!claim.fresh) continue; // pending/ambiguous writes are never blindly replayed
      try {
        if (!await current(name)) throw new Error("Connection revoked");
        await source.assertAuthorized();
        const stored = await ctx.signals.upsert(signal);
        if (stored.isNew && !await ctx.signals.isMuted(signal.fingerprint, ctx.clock.now())) {
          if (!await current(name)) throw new Error("Connection revoked");
          await source.assertAuthorized();
          await options.onSignal(stored.signal);
        }
        await ledger.complete(key, { signalId: stored.signal.id, source: name, eventId: event.id });
      } catch {
        await ledger.markAmbiguous(key, "Telemetry intake outcome requires reconciliation");
      }
    }
    await source.assertAuthorized();
    observations.set(name, { at: ctx.clock.now().getTime(), batch: structuredClone(batch), source });
    try { await options.onObservation?.(); } catch { ctx.log("Telemetry setup reassessment unavailable"); }
    ctx.log("Telemetry observed", { source: name, events: batch.events.length, coverage: batch.coverage });
  };
  const enqueue = async (source: string, at: Date, revision = "") => {
    await ctx.jobs.enqueue("telemetry_provider_poll", `telemetry-poll:${hash([source, Math.floor(at.getTime() / 60_000), revision])}`,
      { source }, { runAt: at });
  };
  ctx.jobs.register("telemetry_provider_poll", async (payload) => {
    const source = (payload as { source?: unknown } | null)?.source;
    if (typeof source !== "string" || source.length > 500) throw new Error("Invalid telemetry polling job");
    if (!await current(source)) return;
    try { await poll(source); }
    catch { observations.delete(source); ctx.log("Telemetry unavailable", { source }); }
    if (await current(source)) await enqueue(source, new Date(ctx.clock.now().getTime() + 60_000));
  });
  return { poll, latest: async () => {
    const result: TelemetryObservation[] = [];
    for (const [name, entry] of observations) {
      const age = ctx.clock.now().getTime() - entry.at;
      if (age < 0 || age > 180_000 || !await current(name)) continue;
      try { await entry.source.assertAuthorized(); result.push(structuredClone(entry.batch)); } catch { observations.delete(name); }
    }
    return result;
  }, stop: () => { stopped = true; observations.clear(); }, start: async (revision = "") => {
    stopped = false;
    for (const source of await options.resolve()) await enqueue(source.name, ctx.clock.now(), revision);
  } };
}
