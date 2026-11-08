// The engine: event → state machine → git journal → projection → effects.
// One writer per trail (serialized in-process). The journal is the durable record; the store is the
// projection that the API reads. Effects run after the journal acknowledged the transition, through the
// operation ledger, so a replay never runs an effect twice. Long work runs as jobs on a background loop.
import {
  TrailEvent, transition, type Effect, type IdGen, type Journal, type OperationLedger, type Trail,
  type TransitionContext,
} from "@ephyra/core";
import { EffectExecutor } from "../orchestrator/effects.ts";
import { InvalidTransition, StaleApproval } from "../http/app.ts";
import { canonicalJson } from "../audit.ts";
import type { EffectHandlers } from "../orchestrator.ts";
import type { EmitInput, JobRunner, ServerContext } from "./context.ts";
import type { RuntimeStore } from "./store.ts";

export type ContextFn = (trail: Trail, event: TrailEvent) => Promise<TransitionContext>;

export class Engine {
  private chains = new Map<string, Promise<unknown>>();
  private handlers: EffectHandlers | null = null;
  private executor: EffectExecutor | null = null;
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
    this.executor = new EffectExecutor(this.ledger, handlers, {
      record: async (key, note) => {
        this.reconciliations.push({ key, note, at: new Date().toISOString() });
        this.log("effect needs reconciliation", { key, note });
      },
    });
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
      const existing = await this.journal.read(trail.id);
      if (!existing) await this.journal.create(trail, initial);
      await this.store.putTrail(trail);
      await this.store.recordEvent(initial);
    });
    await this.dispatch(effects, trail);
  }

  /** Apply one event. Returns the resulting trail, or throws when the state machine rejects it. */
  async emit(input: EmitInput): Promise<Trail> {
    const { trail: trailId, actor, files, eventId, expectedBound, expectedJournalHead, expectedWork, ...body } = input;
    const usageReceipt = body.type === 'usage_recorded' && actor.kind === 'system';
    if (eventId && (files || !usageReceipt && !['human_comment', 'claimed_by_human', 'released_by_human'].includes(body.type))) {
      throw new InvalidTransition('Stable event IDs are limited to collaboration requests');
    }
    const { trail, effects } = await this.serial(trailId, async () => {
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
        await this.store.putTrail(current.trail);
        for (const event of current.events) await this.store.recordEvent(event);
        return { trail: current.trail, effects: [] as Effect[] };
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
      await this.journal.append(trailId, current.head, result.trail, [event], files ?? {});
      await this.store.putTrail(result.trail);
      await this.store.recordEvent(event);
      return result;
    });
    await this.dispatch(effects, trail);
    return trail;
  }

  private async dispatch(effects: Effect[], trail: Trail): Promise<void> {
    if (!this.executor) throw new Error("effect handlers not set");
    for (const effect of effects) {
      try {
        await this.executor.execute(effect, trail);
      } catch (error) {
        // Already recorded by the executor's reconciliation sink; keep dispatching the rest.
        this.log("effect failed", { key: effect.key, type: effect.type, error: String(error) });
      }
    }
  }
}

/** Background job loop over the store's durable queue. */
export class JobLoop {
  private runners = new Map<string, JobRunner>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = 0;
  private stopped = false;
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
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  /** Run every due job once (exposed for tests). */
  async tick(): Promise<number> {
    const free = this.opts.concurrency - this.running;
    let ran = 0;
    if (free > 0) {
      const jobs = await this.store.claim(new Date(), free);
      ran = jobs.length;
      await Promise.all(jobs.map((job) => this.runOne(job)));
    }
    if (!this.stopped) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.tick(), ran ? 0 : this.opts.pollMs);
    }
    return ran;
  }

  /** Drain until no due job remains (tests). */
  async drain(): Promise<void> {
    for (let i = 0; i < 1000; i++) if ((await this.tick()) === 0) return;
    throw new Error("job queue did not drain");
  }

  private async runOne(job: { kind: string; key: string; payload: unknown; attempts: number }): Promise<void> {
    const runner = this.runners.get(job.kind);
    this.running += 1;
    try {
      if (!runner) throw new Error(`no runner for job kind ${job.kind}`);
      await runner(job.payload, { key: job.key, attempt: job.attempts });
      await this.store.finish(job.key);
    } catch (error) {
      const dead = job.attempts >= this.opts.maxAttempts;
      const backoff = 2 ** job.attempts * 5_000;
      await this.store.fail(job.key, String(error), new Date(Date.now() + backoff), dead);
      this.log(dead ? "job dead-lettered" : "job failed, will retry", { key: job.key, kind: job.kind, error: String(error) });
    } finally {
      this.running -= 1;
    }
  }
}
