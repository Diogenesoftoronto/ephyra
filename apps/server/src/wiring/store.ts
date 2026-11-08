// Persistence for the runtime: trail projection, event inbox, inbox items, jobs.
// Two implementations with one interface: MemoryStore (dev/tests) and ConvexRuntimeStore (src/convex/stores.ts).
import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";

export type StoredInboxItem = InboxItem & { id: string };
export type JobRow = { kind: string; key: string; payload: unknown; runAt: Date; attempts: number };

/** A queued or running job, for the console's activity feed. */
export type ActiveJob = { kind: string; key: string; payload: unknown; status: "queued" | "running"; runAt: Date; startedAt?: Date };

export interface RuntimeStore {
  /** Durable stores may fence execution to the active namespace owner. Memory fixtures omit this guard. */
  assertOwner?(): void;
  /** Preserve the owner fence across awaits, including lease expiry followed by a different acquisition. */
  withOwner?<T>(work: () => Promise<T>): Promise<T>;
  getTrail(id: string): Promise<Trail | null>;
  /** Insert or replace the projection. */
  putTrail(trail: Trail): Promise<void>;
  listTrails(states?: Trail["state"][]): Promise<Trail[]>;
  /** Returns false when the event id was already recorded (dedupe). */
  recordEvent(event: TrailEvent): Promise<boolean>;
  events(trailId: string): Promise<TrailEvent[]>;
  inboxPut(item: StoredInboxItem): Promise<void>;
  inboxRemove(id: string): Promise<void>;
  inboxGet(id: string): Promise<StoredInboxItem | null>;
  inboxList(): Promise<StoredInboxItem[]>;
  /** Idempotent by key. */
  enqueue(job: Omit<JobRow, "attempts">): Promise<void>;
  /** Claim up to `n` due jobs (marks them running). */
  claim(now: Date, n: number): Promise<JobRow[]>;
  finish(key: string): Promise<void>;
  /** Failed attempt: retry at `runAt`, or dead-letter when `dead` is true. */
  fail(key: string, error: string, runAt: Date, dead: boolean): Promise<void>;
  deadJobs(): Promise<{ key: string; kind: string; error: string }[]>;
  /** Queued and running jobs (bounded). Optional: a store without it just shows no live jobs in the activity feed. */
  activeJobs?(): Promise<ActiveJob[]>;
}

export class MemoryStore implements RuntimeStore {
  private trails = new Map<string, Trail>();
  private eventLog = new Map<string, TrailEvent[]>();
  private seen = new Set<string>();
  private items = new Map<string, StoredInboxItem>();
  private jobs = new Map<string, JobRow & { status: "queued" | "running" | "done" | "dead"; error?: string; startedAt?: Date }>();

  async getTrail(id: string) { return structuredClone(this.trails.get(id) ?? null); }
  async putTrail(trail: Trail) { this.trails.set(trail.id, structuredClone(trail)); }
  async listTrails(states?: Trail["state"][]) {
    return [...this.trails.values()].filter((t) => !states || states.includes(t.state)).map((t) => structuredClone(t));
  }
  async recordEvent(event: TrailEvent) {
    if (this.seen.has(event.id)) return false;
    this.seen.add(event.id);
    this.eventLog.set(event.trail, [...(this.eventLog.get(event.trail) ?? []), structuredClone(event)]);
    return true;
  }
  async events(trailId: string) { return structuredClone(this.eventLog.get(trailId) ?? []); }
  async inboxPut(item: StoredInboxItem) { this.items.set(item.id, structuredClone(item)); }
  async inboxRemove(id: string) { this.items.delete(id); }
  async inboxGet(id: string) { return structuredClone(this.items.get(id) ?? null); }
  async inboxList() { return [...this.items.values()].map((i) => structuredClone(i)); }
  async enqueue(job: Omit<JobRow, "attempts">) {
    if (!this.jobs.has(job.key)) this.jobs.set(job.key, { ...job, attempts: 0, status: "queued" });
  }
  async claim(now: Date, n: number) {
    const due = [...this.jobs.values()]
      .filter((j) => j.status === "queued" && j.runAt <= now)
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, n);
    for (const j of due) { j.status = "running"; j.attempts += 1; j.startedAt = now; }
    return due.map(({ kind, key, payload, runAt, attempts }) => ({ kind, key, payload, runAt, attempts }));
  }
  async finish(key: string) { const j = this.jobs.get(key); if (j) j.status = "done"; }
  async fail(key: string, error: string, runAt: Date, dead: boolean) {
    const j = this.jobs.get(key);
    if (!j) return;
    j.error = error;
    j.runAt = runAt;
    j.status = dead ? "dead" : "queued";
  }
  async activeJobs(): Promise<ActiveJob[]> {
    return [...this.jobs.values()].filter((j) => j.status === "queued" || j.status === "running").map((j) => ({
      kind: j.kind, key: j.key, payload: structuredClone(j.payload), status: j.status as "queued" | "running", runAt: j.runAt,
      ...(j.startedAt && j.status === "running" ? { startedAt: j.startedAt } : {}),
    }));
  }
  async deadJobs() {
    return [...this.jobs.values()].filter((j) => j.status === "dead").map((j) => ({ key: j.key, kind: j.kind, error: j.error ?? "" }));
  }
}
