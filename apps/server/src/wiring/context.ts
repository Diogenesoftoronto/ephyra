// The contract every wiring module codes against. Implemented in compose.ts over Convex or memory stores;
// FakeContext below is for tests. Wiring modules export `xxxHandlers(ctx, deps)` returning a slice of
// EffectHandlers, and register long-running work as jobs so no effect handler blocks the outbox.
import type {
  Actor, Clock, Effect, IdGen, InboxItem, Journal, JournalFiles, SignalStore, Trail, TrailEvent, TrailEventBody,
} from "@ephyra/core";
import type { AutonomyPolicy, Thresholds } from "@ephyra/policy";
import type { EffectHandlers } from "../orchestrator.ts";

/** The one repository this deployment drives (multi-repo is a later milestone). */
export type RepoConfig = {
  /** Stable id used in Signal.repo and Trail.repo. */
  id: string;
  /** Remote URL the mirror fetches from and landings push to (file://, https://, rad://, ssh). */
  url: string;
  /** Local bare mirror. The journal writes refs/ephyra/trails/* here; forge pushes from here. */
  mirrorDir: string;
  /** e.g. "refs/heads/main" */
  baseRef: string;
  forge: "plain" | "radicle" | "tangled";
  /** Git remote name inside the mirror that landings push to. */
  remote: string;
};

/** `files` are written into the trail's journal tree with the event (hypothesis.md, artefacts/…). */
export type EmitInput = { trail: string; actor: Actor; files?: JournalFiles } & TrailEventBody;

export interface InboxStore {
  put(item: InboxItem & { id: string }): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<(InboxItem & { id: string }) | null>;
  list(): Promise<(InboxItem & { id: string })[]>;
}

export type JobRunner = (payload: unknown, job: { key: string; attempt: number }) => Promise<void>;
export interface Jobs {
  /** Register the runner for a job kind once at startup. */
  register(kind: string, runner: JobRunner): void;
  /** Durable, idempotent by key: enqueueing an existing key is a no-op. Returns immediately. */
  enqueue(kind: string, key: string, payload: unknown, opts?: { runAt?: Date }): Promise<void>;
}

export interface ServerContext {
  repo: RepoConfig;
  policy: { autonomy: AutonomyPolicy; thresholds: Thresholds };
  journal: Journal;
  signals: SignalStore;
  inbox: InboxStore;
  jobs: Jobs;
  clock: Clock;
  ids: IdGen;
  /** Apply an event through the orchestrator (validates via the state machine, journals, dispatches effects). */
  emit(input: EmitInput): Promise<void>;
  /** Seed a newly created trail (from core createTrail) and dispatch its initial effects. */
  start(trail: Trail, initial: TrailEvent, effects?: Effect[]): Promise<void>;
  trails: {
    get(id: string): Promise<Trail | null>;
    list(filter?: { states?: Trail["state"][] }): Promise<Trail[]>;
    events(id: string): Promise<TrailEvent[]>;
  };
  log(msg: string, fields?: Record<string, unknown>): void;
}

/** A slice of the effect table; compose.ts merges slices and checks every effect type is covered. */
export type HandlerSlice = Partial<EffectHandlers>;

// ───────────────────────── Test double ─────────────────────────

/** In-memory context for wiring-module tests. Records emitted events instead of running the state machine. */
export class FakeContext implements ServerContext {
  emitted: EmitInput[] = [];
  started: { trail: Trail; initial: TrailEvent; effects: Effect[] }[] = [];
  logs: { msg: string; fields?: Record<string, unknown> }[] = [];
  jobRunners = new Map<string, JobRunner>();
  queued: { kind: string; key: string; payload: unknown; runAt?: Date }[] = [];
  private items = new Map<string, InboxItem & { id: string }>();
  private store = new Map<string, Trail>();
  private eventLog = new Map<string, TrailEvent[]>();

  constructor(
    public repo: RepoConfig,
    public policy: ServerContext["policy"],
    public journal: Journal,
    public signals: SignalStore,
    public clock: Clock = { now: () => new Date() },
    public ids: IdGen = { uuidv7: () => crypto.randomUUID() },
  ) {}

  inbox: InboxStore = {
    put: async (item) => { this.items.set(item.id, item); },
    remove: async (id) => { this.items.delete(id); },
    get: async (id) => this.items.get(id) ?? null,
    list: async () => [...this.items.values()],
  };
  jobs: Jobs = {
    register: (kind, runner) => { this.jobRunners.set(kind, runner); },
    enqueue: async (kind, key, payload, opts) => {
      if (this.queued.some((q) => q.key === key)) return;
      this.queued.push({ kind, key, payload, runAt: opts?.runAt });
    },
  };
  trails = {
    get: async (id: string) => this.store.get(id) ?? null,
    list: async (filter?: { states?: Trail["state"][] }) =>
      [...this.store.values()].filter((t) => !filter?.states || filter.states.includes(t.state)),
    events: async (id: string) => this.eventLog.get(id) ?? [],
  };

  /** Test helper: make a trail visible to `trails.get/list`. */
  put(trail: Trail): void { this.store.set(trail.id, trail); }

  /** Test helper: run every queued job whose kind has a registered runner. */
  async drainJobs(): Promise<void> {
    while (this.queued.length) {
      const job = this.queued.shift()!;
      const runner = this.jobRunners.get(job.kind);
      if (!runner) throw new Error(`no runner registered for job kind ${job.kind}`);
      await runner(job.payload, { key: job.key, attempt: 1 });
    }
  }

  async emit(input: EmitInput): Promise<void> { this.emitted.push(input); }
  async start(trail: Trail, initial: TrailEvent, effects: Effect[] = []): Promise<void> {
    this.started.push({ trail, initial, effects });
    this.put(trail);
  }
  log(msg: string, fields?: Record<string, unknown>): void { this.logs.push({ msg, fields }); }
}
