// Convex-backed implementations of the server's persistence ports. Every call carries the shared secret;
// every payload read back is validated with the core zod schemas before it is trusted.
import { ConvexHttpClient } from "convex/browser";
import {
  Signal, Trail, TrailEvent, type InboxItem, type OperationLedger, type OperationRecord, type SignalStore,
} from "@ephyra/core";
import { api } from "../../convex/_generated/api";
import type { AuditEvent, AuditInput } from "../audit.ts";
import type { ActiveJob, JobRow, RuntimeStore, StoredInboxItem } from "../wiring/store.ts";

export type ConvexConfig = { url: string; secret: string };

export function convexClient(config: ConvexConfig): ConvexHttpClient {
  if (config.secret.length < 32) throw new Error("EPHYRA_CONVEX_SECRET must be at least 32 characters");
  return new ConvexHttpClient(config.url);
}

const topInAppFile = (s: Signal) => s.frames.find((f) => f.inApp)?.file;

export class ConvexSignalStore implements SignalStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}

  async upsert(signal: Signal) {
    const valid = Signal.parse(signal);
    const file = topInAppFile(valid);
    const result = await this.client.mutation(api.signals.upsert, {
      secret: this.secret, json: JSON.stringify(valid), ...(file ? { topInAppFile: file } : {}),
    });
    return { signal: Signal.parse(JSON.parse(result.json)), isNew: result.isNew };
  }
  async get(id: string) {
    const json = await this.client.query(api.signals.get, { secret: this.secret, signalId: id });
    return json ? Signal.parse(JSON.parse(json)) : null;
  }
  async byFingerprint(fingerprint: string) {
    const json = await this.client.query(api.signals.byFingerprint, { secret: this.secret, fingerprint });
    return json ? Signal.parse(JSON.parse(json)) : null;
  }
  async countSince(fingerprint: string, since: Date) {
    return this.client.query(api.signals.countSince, { secret: this.secret, fingerprint, sinceMs: since.getTime() });
  }
  async newFingerprintsInFiles(files: string[], since: Date) {
    const rows = await this.client.query(api.signals.newInFiles, { secret: this.secret, files, sinceMs: since.getTime() });
    return rows.map((json) => Signal.parse(JSON.parse(json)));
  }
  /** Called by the OTLP routes for every request span, so error rates have a denominator. */
  async recordRequest(route: string, at: Date, error: boolean) {
    await this.client.mutation(api.signals.recordRequest, { secret: this.secret, route, atMs: at.getTime(), error });
  }
  async errorRate(route: string, from: Date, to: Date) {
    return this.client.query(api.signals.errorRate, { secret: this.secret, route, fromMs: from.getTime(), toMs: to.getTime() });
  }
  async mute(fingerprint: string, until: Date) {
    await this.client.mutation(api.signals.mute, { secret: this.secret, fingerprint, untilMs: until.getTime() });
  }
  async isMuted(fingerprint: string, at: Date) {
    return this.client.query(api.signals.isMuted, { secret: this.secret, fingerprint, atMs: at.getTime() });
  }
}

export class ConvexRuntimeStore implements RuntimeStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}

  async getTrail(id: string) {
    const json = await this.client.query(api.runtime.getTrail, { secret: this.secret, trailId: id });
    return json ? Trail.parse(JSON.parse(json)) : null;
  }
  async putTrail(trail: Trail) {
    const valid = Trail.parse(trail);
    await this.client.mutation(api.runtime.putTrail, {
      secret: this.secret, trailId: valid.id, state: valid.state, json: JSON.stringify(valid),
    });
  }
  async listTrails(states?: Trail["state"][]) {
    const rows = await this.client.query(api.runtime.listTrails, { secret: this.secret, ...(states ? { states } : {}) });
    return rows.map((json) => Trail.parse(JSON.parse(json)));
  }
  async recordEvent(event: TrailEvent) {
    const valid = TrailEvent.parse(event);
    return this.client.mutation(api.runtime.recordEvent, {
      secret: this.secret, eventId: valid.id, trailId: valid.trail, json: JSON.stringify(valid),
    });
  }
  async events(trailId: string) {
    const rows = await this.client.query(api.runtime.events, { secret: this.secret, trailId });
    return rows.map((json) => TrailEvent.parse(JSON.parse(json)));
  }
  async inboxPut(item: StoredInboxItem) {
    await this.client.mutation(api.runtime.inboxPut, {
      secret: this.secret, itemId: item.id, trailId: item.trailId, json: JSON.stringify(item),
    });
  }
  async inboxRemove(id: string) { await this.client.mutation(api.runtime.inboxRemove, { secret: this.secret, itemId: id }); }
  async inboxGet(id: string) {
    const json = await this.client.query(api.runtime.inboxGet, { secret: this.secret, itemId: id });
    return json ? (JSON.parse(json) as StoredInboxItem) : null;
  }
  async inboxList() {
    const rows = await this.client.query(api.runtime.inboxList, { secret: this.secret });
    return rows.map((json) => JSON.parse(json) as InboxItem & { id: string });
  }
  async enqueue(job: Omit<JobRow, "attempts">) {
    await this.client.mutation(api.runtime.enqueue, {
      secret: this.secret, key: job.key, kind: job.kind, payload: JSON.stringify(job.payload ?? null), runAtMs: job.runAt.getTime(),
    });
  }
  async claim(now: Date, n: number) {
    const rows = await this.client.mutation(api.runtime.claim, { secret: this.secret, nowMs: now.getTime(), limit: n });
    return rows.map((r) => ({ key: r.key, kind: r.kind, payload: JSON.parse(r.payload), runAt: new Date(r.runAtMs), attempts: r.attempts }));
  }
  async finish(key: string) { await this.client.mutation(api.runtime.finish, { secret: this.secret, key }); }
  async fail(key: string, error: string, runAt: Date, dead: boolean) {
    await this.client.mutation(api.runtime.fail, { secret: this.secret, key, error, runAtMs: runAt.getTime(), dead });
  }
  async deadJobs() { return this.client.query(api.runtime.deadJobs, { secret: this.secret }); }
  async activeJobs(): Promise<ActiveJob[]> {
    const rows = await this.client.query(api.runtime.activeJobs, { secret: this.secret });
    return rows.map((r) => ({
      kind: r.kind, key: r.key, payload: JSON.parse(r.payload), status: r.status, runAt: new Date(r.runAtMs),
      ...(r.startedMs != null && r.status === "running" ? { startedAt: new Date(r.startedMs) } : {}),
    }));
  }
  async recoverRunning() { return this.client.mutation(api.runtime.recoverRunning, { secret: this.secret }); }
}

export class ConvexOperationLedger implements OperationLedger {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}

  private static toRecord(r: { key: string; planDigest: string; status: string; result: string | null; at: string }): OperationRecord {
    return {
      key: r.key, planDigest: r.planDigest, status: r.status as OperationRecord["status"], at: r.at,
      ...(r.result != null ? { result: JSON.parse(r.result) } : {}),
    };
  }
  async begin(key: string, planDigest: string) {
    const r = await this.client.mutation(api.ledger.begin, { secret: this.secret, key, planDigest, at: new Date().toISOString() });
    return r.fresh ? { fresh: true as const } : { fresh: false as const, record: ConvexOperationLedger.toRecord(r.record!) };
  }
  async complete(key: string, result: unknown) {
    await this.client.mutation(api.ledger.complete, { secret: this.secret, key, result: JSON.stringify(result ?? null) });
  }
  async markAmbiguous(key: string, note: string) {
    await this.client.mutation(api.ledger.markAmbiguous, { secret: this.secret, key, note });
  }
  async get(key: string) {
    const r = await this.client.query(api.ledger.get, { secret: this.secret, key });
    return r ? ConvexOperationLedger.toRecord(r) : null;
  }
  async recordReconciliation(key: string, note: string) {
    await this.client.mutation(api.ledger.recordReconciliation, { secret: this.secret, key, note, at: new Date().toISOString() });
  }
  async reconciliations() { return this.client.query(api.ledger.reconciliations, { secret: this.secret }); }
}

export class ConvexAudit {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}
  async append(input: AuditInput): Promise<AuditEvent> {
    const { prevHash, hash } = await this.client.mutation(api.audit.append, { secret: this.secret, json: JSON.stringify(input) });
    return { ...input, prevHash, hash };
  }
  async list(): Promise<AuditEvent[]> {
    const rows = await this.client.query(api.audit.list, { secret: this.secret });
    return rows.map((r) => ({ ...(JSON.parse(r.json) as AuditInput), prevHash: r.prevHash, hash: r.hash }));
  }
}
