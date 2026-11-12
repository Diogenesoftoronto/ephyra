// The engine: event → state machine → git journal → projection → effects.
// One writer per trail (serialized in-process). The journal is the durable record; the store is the
// projection that the API reads. Effects run after the journal acknowledged the transition, through the
// operation ledger, so a replay never runs an effect twice. Long work runs as jobs on a background loop.
import {
  TrailEvent, transition, type Effect, type IdGen, type Journal, type JournalFiles, type OperationLedger, type Trail,
  type TransitionContext,
} from "@ephyra/core";
import { EffectExecutor } from "../orchestrator/effects.ts";
import { InvalidTransition, StaleApproval } from "../http/app.ts";
import { canonicalJson } from "../audit.ts";
import type { EffectHandlers } from "../orchestrator.ts";
import type { EmitInput, JobRunner, ServerContext } from "./context.ts";
import type { RuntimeStore } from "./store.ts";
import {
  appendEffects, EFFECT_HISTORY_PATH, EFFECT_OUTBOX_PATH, effectHistory, effectIsCurrent, effectOutbox, readEffectHistory, readEffectOutbox,
  recordEffects, type PendingEffect,
} from "./effect-outbox.ts";
import { WorkerOwnershipLost } from "./worker-lease.ts";

export type ContextFn = (trail: Trail, event: TrailEvent) => Promise<TransitionContext>;

export class Engine {
  private chains = new Map<string, Promise<unknown>>();
  private handlers: EffectHandlers | null = null;
  private executor: EffectExecutor | null = null;
  private ownershipGuard: (() => void | Promise<void>) | undefined;
  private inFlightEffects = new Set<string>();
  private completedEffects = new Set<string>();
  readonly reconciliations: { key: string; note: string; at: string }[] = [];

  constructor(
    private readonly store: RuntimeStore,
    private readonly journal: Journal,
    private readonly ledger: OperationLedger,
    private readonly contextFor: ContextFn,
    private readonly ids: IdGen,
    private readonly log: ServerContext["log"],
  ) {}

  setHandlers(handlers: EffectHandlers): void {
    this.handlers = handlers;
    const guarded = new Proxy(handlers, { get: (target, property) => {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? async (...args: unknown[]) => {
        await this.assertOwned();
        return Reflect.apply(value, target, args);
      } : value;
    } });
    this.executor = new EffectExecutor(this.ledger, guarded, {
      record: async (key, note) => {
        this.reconciliations.push({ key, note, at: new Date().toISOString() });
        this.log("effect needs reconciliation", { key, note });
      },
    });
  }

  setOwnershipGuard(guard: () => void | Promise<void>): void { this.ownershipGuard = guard; }
  private async assertOwned(): Promise<void> { await this.ownershipGuard?.(); }

  private async project(trail: Trail, events: TrailEvent[]): Promise<void> {
    await this.assertOwned();
    await this.store.putTrail(trail);
    for (const event of events) { await this.assertOwned(); await this.store.recordEvent(event); }
  }

  private async pending(trailId: string): Promise<PendingEffect[]> {
    return (await readEffectOutbox(this.journal, trailId)).filter(entry => !this.completedEffects.has(entry.effect.key));
  }

  /**
   * The history file to write with a transition, or nothing when the transition asked for no effects. A history that
   * cannot be read is left exactly as it is: the transition must still go through, and a reader is told it is unreadable.
   */
  private async recorded(trailId: string, exists: boolean, cause: string, effects: readonly Effect[]): Promise<JournalFiles> {
    if (!effects.length) return {};
    try {
      const history = exists ? await readEffectHistory(this.journal, trailId) : [];
      return { [EFFECT_HISTORY_PATH]: effectHistory(recordEffects(history, cause, effects)) };
    } catch (error) {
      this.log("effect history left unchanged", { trail: trailId, error: String(error) });
      return {};
    }
  }

  /** Serialize all work on one trail. */
  private serial<T>(trailId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(trailId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    this.chains.set(trailId, next);
    return next;
  }

  /** Create a new trail: journal it, project it, then dispatch the initial effects. */
  async start(trail: Trail, initial: TrailEvent, effects: Effect[] = []): Promise<void> {
    await this.serial(trail.id, async () => {
      await this.assertOwned();
      const existing = await this.journal.read(trail.id);
      const recorded = existing?.events.find(event => event.id === initial.id);
      if (existing && recorded) {
        if (canonicalJson({ actor: recorded.actor, type: recorded.type, data: recorded.data })
          !== canonicalJson({ actor: initial.actor, type: initial.type, data: initial.data })) {
          throw new InvalidTransition("The trail start key was used for different content");
        }
        await this.project(existing.trail, existing.events);
        return;
      }
      const entries = appendEffects(existing ? await this.pending(trail.id) : [], initial.id, trail, effects);
      const files = { ...await this.recorded(trail.id, existing !== null, initial.id, effects), [EFFECT_OUTBOX_PATH]: effectOutbox(entries) };
      await this.assertOwned();
      if (!existing) await this.journal.create(trail, initial, files);
      else {
        if (existing.trail.state !== "closed" || trail.state !== "researching" || trail.rev !== existing.trail.rev + 1) {
          throw new InvalidTransition("An existing trail requires its recorded start or a new closed-trail regression revision");
        }
        await this.journal.append(trail.id, existing.head, trail, [initial], files);
      }
      await this.project(trail, [initial]);
    });
    await this.deliverPending(trail.id);
  }

  /** Apply one event. Returns the resulting trail, or throws when the state machine rejects it. */
  async emit(input: EmitInput): Promise<Trail> {
    const { trail: trailId, actor, files, eventId, expectedBound, expectedJournalHead, expectedWork, ...body } = input;
    const usageReceipt = body.type === 'usage_recorded' && actor.kind === 'system';
    if (eventId && (files || !usageReceipt && !['human_comment', 'claimed_by_human', 'released_by_human'].includes(body.type))) {
      throw new InvalidTransition('Stable event IDs are limited to collaboration requests');
    }
    if (Object.keys(files ?? {}).some(path => path.startsWith("outbox/"))) throw new InvalidTransition("The effect outbox is reserved");
    const trail = await this.serial(trailId, async () => {
      await this.assertOwned();
      const current = await this.journal.read(trailId);
      if (!current) throw new Error(`unknown trail ${trailId}`);
      if (expectedJournalHead !== undefined && current.head !== expectedJournalHead)
        throw new StaleApproval('The evidence changed before the decision was applied');
      const recorded = eventId && current.events.find((e) => e.id === eventId);
      if (recorded) {
        const intent = { actor, ...body };
        const previous = { actor: recorded.actor, type: recorded.type, data: recorded.data };
        if (canonicalJson(intent) !== canonicalJson(previous)) throw new InvalidTransition('Operation key was used for different content');
        // A journal append can succeed before projection fails. Repair from the latest durable state,
        // rather than rolling back to the state that happened to follow this older operation.
        await this.project(current.trail, current.events);
        return current.trail;
      }
      if (expectedWork && (current.trail.rev !== expectedWork.rev || current.trail.head !== expectedWork.head
        || current.trail.base.sha !== expectedWork.base || current.trail.state !== expectedWork.state
        || current.trail.policyCommit !== expectedWork.policyCommit || current.trail.workGeneration !== expectedWork.generation)) {
        throw new StaleApproval('The code or workflow changed while the agent was running');
      }
      if (expectedBound) {
        const proof = [...current.events].reverse().find((e) => e.type === 'proof_completed' && e.data.bundle.rev === current.trail.rev);
        const digest = proof?.type === 'proof_completed' ? proof.data.digest : undefined;
        if (expectedBound.rev !== current.trail.rev || expectedBound.head !== current.trail.head || expectedBound.proofDigest !== digest) {
          throw new StaleApproval('The reviewed revision changed before the decision was applied');
        }
      }
      const event = TrailEvent.parse({
        schema: 1, id: eventId ?? this.ids.uuidv7(), trail: trailId, rev: current.trail.rev, at: new Date().toISOString(),
        actor, parent: current.events.at(-1)?.id, ...body,
      });
      const result = transition(current.trail, event, await this.contextFor(current.trail, event));
      if (!result.ok) throw new InvalidTransition(result.error);
      // CAS append: a concurrent writer outside this process makes this throw rather than overwrite.
      const entries = appendEffects(await this.pending(trailId), event.id, result.trail, result.effects);
      const history = await this.recorded(trailId, true, event.id, result.effects);
      await this.assertOwned();
      await this.journal.append(trailId, current.head, result.trail, [event],
        { ...files, ...history, [EFFECT_OUTBOX_PATH]: effectOutbox(entries) });
      await this.project(result.trail, [event]);
      return result.trail;
    });
    await this.deliverPending(trailId);
    return trail;
  }

  /**
   * Add files to a trail's journal without an event, in the same per-trail queue as every transition, so it can never
   * race one. Returns false, and writes nothing, when the trail has moved on from the work the files describe.
   */
  async attach(trailId: string, files: JournalFiles, expected?: { rev: number; state: Trail["state"]; generation?: number }): Promise<boolean> {
    if (Object.keys(files).some(path => path.startsWith("outbox/"))) throw new InvalidTransition("The effect outbox is reserved");
    return this.serial(trailId, async () => {
      await this.assertOwned();
      const current = await this.journal.read(trailId);
      if (!current) return false;
      if (expected && (current.trail.rev !== expected.rev || current.trail.state !== expected.state
        || (current.trail.workGeneration ?? 0) !== (expected.generation ?? 0))) return false;
      await this.journal.append(trailId, current.head, current.trail, [], files);
      return true;
    });
  }

  /** Repair every durable projection before policy reload or any pending effect is delivered. */
  async recoverProjections(trailId?: string): Promise<void> {
    await this.assertOwned();
    for (const id of trailId ? [trailId] : await this.journal.list()) {
      await this.serial(id, async () => {
        const current = await this.journal.read(id);
        if (current) await this.project(current.trail, current.events);
      });
    }
  }

  /** After owner acquisition, restore projections/policy first; direct callers also get projection repair by default. */
  async recoverEffects(trailId?: string, options: { project?: boolean } = {}): Promise<void> {
    await this.assertOwned();
    if (options.project !== false) await this.recoverProjections(trailId);
    for (const id of trailId ? [trailId] : await this.journal.list()) await this.deliverPending(id);
  }

  private async superseded(entry: PendingEffect): Promise<void> {
    await this.serial(entry.trail.id, async () => {
      const current = await this.journal.read(entry.trail.id);
      if (!current) return;
      const pending = (await this.pending(entry.trail.id)).filter(value => value.effect.key !== entry.effect.key);
      await this.assertOwned();
      await this.journal.append(entry.trail.id, current.head, current.trail, [], {
        [EFFECT_OUTBOX_PATH]: effectOutbox(pending),
      });
      this.completedEffects.add(entry.effect.key);
    });
  }

  private async deliverPending(trailId: string): Promise<void> {
    if (!this.executor) throw new Error("effect handlers not set");
    for (const entry of await this.pending(trailId)) {
      const effect = entry.effect;
      if (this.inFlightEffects.has(effect.key)) continue;
      await this.assertOwned();
      this.inFlightEffects.add(effect.key);
      try {
        const previous = await this.ledger.get(effect.key);
        if (previous?.status === "done") { this.completedEffects.add(effect.key); continue; }
        if (previous) {
          if (!this.reconciliations.some(value => value.key === effect.key)) {
            this.reconciliations.push({ key: effect.key, note: `operation is ${previous.status}; reconcile before delivery`, at: previous.at });
          }
          continue; // An external request may already have happened. Never dispatch it automatically again.
        }
        const current = await this.journal.read(trailId);
        if (!current || !current.events.some(event => event.id === entry.eventId)) throw new Error("effect has no durable source event");
        if (!effectIsCurrent(entry, current.trail)) { await this.superseded(entry); continue; }
        await this.assertOwned();
        await this.executor.execute(structuredClone(effect), structuredClone(entry.trail));
        this.completedEffects.add(effect.key);
      } catch (error) {
        // Already recorded by the executor's reconciliation sink; keep dispatching the rest.
        this.log("effect failed", { key: effect.key, type: effect.type, error: String(error) });
      } finally { this.inFlightEffects.delete(effect.key); }
    }
  }
}

/** Background job loop over the store's durable queue. */
export class JobLoop {
  private runners = new Map<string, JobRunner>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = 0;
  private stopped = true;
  private started = false;

  constructor(
    private readonly store: RuntimeStore,
    private readonly log: ServerContext["log"],
    private readonly opts: { concurrency: number; pollMs: number; maxAttempts: number } = { concurrency: 2, pollMs: 1000, maxAttempts: 3 },
  ) {}

  register(kind: string, runner: JobRunner): void { this.runners.set(kind, runner); }

  async enqueue(kind: string, key: string, payload: unknown, opts?: { runAt?: Date }): Promise<void> {
    await this.store.enqueue({ kind, key, payload, runAt: opts?.runAt ?? new Date() });
    this.kick();
  }

  start(): void { if (this.started) return; this.started = true; this.stopped = false; this.kick(); }
  stop(): void { this.started = false; this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  private kick(): void {
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(error => {
        this.log("job polling failed", { error: error instanceof Error ? error.name : "UnknownError" });
        this.schedule(this.opts.pollMs);
      });
    }, delay);
  }

  private ownsWork(): boolean {
    try { this.store.assertOwner?.(); return true; }
    catch { return false; }
  }

  /** Run every due job once (exposed for tests). */
  async tick(): Promise<number> {
    const work = async () => {
      const free = this.opts.concurrency - this.running;
      let ran = 0;
      if (free > 0 && this.ownsWork()) {
        const jobs = await this.store.claim(new Date(), free);
        ran = jobs.length;
        await Promise.all(jobs.map((job) => this.runOne(job)));
      }
      return ran;
    };
    // Poll timers may inherit a retired job's async context. Bind the physical owner once at this entry,
    // then preserve that captured fence throughout claim, execution and completion.
    const ran = this.store.withOwner ? await this.store.withOwner(work) : await work();
    this.schedule(ran ? 0 : this.opts.pollMs);
    return ran;
  }

  /** Drain until no due job remains (tests). */
  async drain(): Promise<void> {
    for (let i = 0; i < 1000; i++) if ((await this.tick()) === 0) return;
    throw new Error("job queue did not drain");
  }

  private async runOne(job: { kind: string; key: string; payload: unknown; attempts: number }): Promise<void> {
    const ownershipLost = () => this.log("job ownership lost; reconciliation required", { key: job.key, kind: job.kind });
    if (!this.ownsWork()) { ownershipLost(); return; }
    const runner = this.runners.get(job.kind);
    this.running += 1;
    try {
      if (!runner) throw new Error(`no runner for job kind ${job.kind}`);
      await runner(job.payload, { key: job.key, attempt: job.attempts });
      if (!this.ownsWork()) { ownershipLost(); return; }
      await this.store.finish(job.key);
    } catch (error) {
      // The provider may have completed. Keep this claim running for lease takeover quarantine;
      // requeueing it could repeat an external side effect.
      if (error instanceof WorkerOwnershipLost || !this.ownsWork()) { ownershipLost(); return; }
      const dead = job.attempts >= this.opts.maxAttempts;
      const backoff = 2 ** job.attempts * 5_000;
      try { await this.store.fail(job.key, String(error), new Date(Date.now() + backoff), dead); }
      catch (failure) {
        if (failure instanceof WorkerOwnershipLost || !this.ownsWork()) { ownershipLost(); return; }
        throw failure;
      }
      this.log(dead ? "job dead-lettered" : "job failed, will retry", { key: job.key, kind: job.kind, error: String(error) });
    } finally {
      this.running -= 1;
    }
  }
}
