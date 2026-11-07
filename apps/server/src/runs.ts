// Agent runs for the console's live view: the RunStore (memory + Convex), a recorder that buffers and stamps events, and a broker that
// wakes SSE readers. Recording never fails the step it observes.
import { AgentRun, AgentRunEvent, type PersonaId } from "@ephyra/core";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { safeNote } from "./usage.ts";

export type RunFilter = { trail?: string; status?: AgentRun["status"]; limit: number };
export type EventDraft = Omit<AgentRunEvent, "runId" | "seq" | "at"> & { at?: string };

export interface RunStore {
  /** Idempotent by run id. */
  create(run: AgentRun): Promise<void>;
  /** Replace the run record (the recorder merges). Returns false for an unknown run. */
  put(run: AgentRun): Promise<boolean>;
  get(id: string): Promise<AgentRun | null>;
  /** Running first, then newest. `trail` matches a trail id or short name. */
  list(filter: RunFilter): Promise<AgentRun[]>;
  /** Append events in order; seq is assigned by the store, monotonic per run. Returns the stored events. */
  append(runId: string, events: (Omit<AgentRunEvent, "runId" | "seq">)[]): Promise<AgentRunEvent[]>;
  /** Events with seq > after (all when undefined), oldest first. */
  events(runId: string, after: number | undefined, limit: number): Promise<AgentRunEvent[]>;
  /** Marks runs still "running" as failed (the server that was running them is gone). Returns how many. */
  closeRunning(reason: string, endedAt: Date): Promise<number>;
}

const rank = (r: AgentRun) => (r.status === "running" ? 0 : 1);
export const orderRuns = (runs: AgentRun[]): AgentRun[] =>
  [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
const matchesTrail = (r: AgentRun, trail?: string) => !trail || r.trailId === trail || r.short === trail;

export class MemoryRunStore implements RunStore {
  private runs = new Map<string, AgentRun>();
  private log = new Map<string, AgentRunEvent[]>();
  async create(run: AgentRun) { if (!this.runs.has(run.id)) this.runs.set(run.id, AgentRun.parse(structuredClone(run))); }
  async put(run: AgentRun) {
    if (!this.runs.has(run.id)) return false;
    this.runs.set(run.id, AgentRun.parse(structuredClone(run)));
    return true;
  }
  async get(id: string) { const r = this.runs.get(id); return r ? structuredClone(r) : null; }
  async list(f: RunFilter) {
    return orderRuns([...this.runs.values()].filter((r) => matchesTrail(r, f.trail) && (!f.status || r.status === f.status)))
      .slice(0, f.limit).map((r) => structuredClone(r));
  }
  async append(runId: string, events: Omit<AgentRunEvent, "runId" | "seq">[]) {
    if (!this.runs.has(runId)) throw new Error("unknown run");
    const list = this.log.get(runId) ?? [];
    const stored = events.map((e, i) => AgentRunEvent.parse({ ...e, runId, seq: list.length + i }));
    this.log.set(runId, [...list, ...stored]);
    return structuredClone(stored);
  }
  async events(runId: string, after: number | undefined, limit: number) {
    return structuredClone((this.log.get(runId) ?? []).filter((e) => after === undefined || e.seq > after).slice(0, limit));
  }
  async closeRunning(reason: string, endedAt: Date) {
    let n = 0;
    for (const [id, r] of this.runs) {
      if (r.status !== "running") continue;
      this.runs.set(id, { ...r, status: "failed", endedAt: endedAt.toISOString(), error: safeNote(reason, 500) });
      n += 1;
    }
    return n;
  }
}

export class ConvexRunStore implements RunStore {
  constructor(private readonly client: ConvexHttpClient, private readonly secret: string) {}
  async create(run: AgentRun) {
    const valid = AgentRun.parse(run);
    await this.client.mutation(api.runs.create, { secret: this.secret, runId: valid.id, json: JSON.stringify(valid) });
  }
  async put(run: AgentRun) {
    const valid = AgentRun.parse(run);
    return this.client.mutation(api.runs.update, { secret: this.secret, runId: valid.id, json: JSON.stringify(valid) });
  }
  async get(id: string) {
    const json = await this.client.query(api.runs.get, { secret: this.secret, runId: id });
    return json ? AgentRun.parse(JSON.parse(json)) : null;
  }
  async list(f: RunFilter) {
    const parse = (rows: string[]) => rows.map((j) => AgentRun.parse(JSON.parse(j)));
    // A trail filter may be a short name; the index is on the id, so resolve it client-side from a wider read.
    const byId = /^[0-9a-f-]{36}$/.test(f.trail ?? "");
    const recent = parse(await this.client.query(api.runs.list, {
      secret: this.secret, ...(byId ? { trailId: f.trail } : {}), ...(f.status ? { status: f.status } : {}), limit: byId ? f.limit : 200,
    }));
    // Running runs are always shown, even when many newer runs have finished since they started.
    const running = f.status && f.status !== "running" ? [] : parse(await this.client.query(api.runs.list, {
      secret: this.secret, ...(byId ? { trailId: f.trail } : {}), status: "running", limit: 200,
    }));
    const merged = new Map([...recent, ...running].map((r) => [r.id, r]));
    return orderRuns([...merged.values()].filter((r) => matchesTrail(r, f.trail))).slice(0, f.limit);
  }
  async append(runId: string, events: Omit<AgentRunEvent, "runId" | "seq">[]) {
    const out: AgentRunEvent[] = [];
    for (let i = 0; i < events.length; i += 100) {
      const batch = events.slice(i, i + 100);
      const first = await this.client.mutation(api.runs.appendEvents, { secret: this.secret, runId, events: batch.map((e) => JSON.stringify(e)) });
      out.push(...batch.map((e, k) => AgentRunEvent.parse({ ...e, runId, seq: first + k })));
    }
    return out;
  }
  async events(runId: string, after: number | undefined, limit: number) {
    const rows = await this.client.query(api.runs.events, { secret: this.secret, runId, ...(after !== undefined ? { after } : {}), limit });
    return rows.map((j) => AgentRunEvent.parse(JSON.parse(j)));
  }
  async closeRunning(reason: string, endedAt: Date) {
    return this.client.mutation(api.runs.closeRunning, { secret: this.secret, reason: safeNote(reason, 500), endedAt: endedAt.toISOString() });
  }
}

/** Wakes readers waiting for new events or for a run to close (same process; others poll). */
export class RunBroker {
  private waiters = new Map<string, Set<() => void>>();
  notify(runId: string): void { for (const wake of [...(this.waiters.get(runId) ?? [])]) wake(); }
  /** Resolves when the run changes, after `ms`, or when `signal` aborts. */
  wait(runId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(runId) ?? new Set();
      this.waiters.set(runId, set);
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.waiters.delete(runId); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export type RunStart = {
  id: string; trailId: string | null; short: string | null; step: string; persona: PersonaId | null; engine: string; executor: AgentRun["executor"];
};
export type RunHandle = {
  readonly id: string;
  event(e: EventDraft): Promise<void>;
  /** Details that become known mid-run: orb/sandbox id, Amp thread URL, portal URL. */
  executor(patch: Partial<AgentRun["executor"]>): void;
  /** Flush buffered events and close the run. */
  finish(end: { status: Exclude<AgentRun["status"], "running">; engine?: string; usage?: { tokens: number | null; costMicrousd: number | null }; error?: string }): Promise<void>;
};

const FLUSH_MS = 250;
const FLUSH_AT = 20;

/** Creates runs, buffers their events (a Convex mutation per event would be chatty), and closes them. Never throws. */
export class RunRecorder {
  constructor(
    private readonly store: RunStore, private readonly broker: RunBroker,
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(s: RunStart): Promise<RunHandle> {
    let run: AgentRun = AgentRun.parse({ ...s, status: "running", startedAt: this.now().toISOString() });
    const safe = async (what: string, work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { this.log(`run ${what} failed`, { run: s.id, error: safeNote(String(error)) }); }
    };
    await safe("create", () => this.store.create(run));
    this.broker.notify(s.id);

    let buffer: Omit<AgentRunEvent, "runId" | "seq">[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    const flush = (): Promise<unknown> => {
      if (timer) { clearTimeout(timer); timer = null; }
      const batch = buffer;
      buffer = [];
      if (!batch.length) return chain;
      chain = chain.then(() => safe("append", () => this.store.append(s.id, batch))).then(() => this.broker.notify(s.id));
      return chain;
    };
    let patch: Partial<AgentRun["executor"]> = {};
    return {
      id: s.id,
      event: async (e) => {
        const { at, ...rest } = e;
        const parsed = AgentRunEvent.omit({ runId: true, seq: true }).safeParse({ ...rest, at: at ?? this.now().toISOString() });
        if (!parsed.success) { this.log("run event dropped (invalid)", { run: s.id }); return; }
        buffer.push(parsed.data);
        if (buffer.length >= FLUSH_AT) await flush();
        else if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
      },
      executor: (p) => {
        patch = { ...patch, ...p };
        run = AgentRun.parse({ ...run, executor: { ...run.executor, ...patch } });
        const snapshot = run;
        chain = chain.then(() => safe("update", () => this.store.put(snapshot))).then(() => this.broker.notify(s.id));
      },
      finish: async (end) => {
        await flush();
        run = AgentRun.parse({
          ...run, status: end.status, endedAt: this.now().toISOString(), ...(end.engine ? { engine: end.engine } : {}),
          ...(end.usage ? { usage: end.usage } : {}), ...(end.error ? { error: safeNote(end.error, 500) } : {}),
        });
        await chain;
        await safe("close", () => this.store.put(run));
        this.broker.notify(s.id);
      },
    };
  }
}
