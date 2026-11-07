import { ReconciliationRequired, type Effect, type Journal, type Trail, type TrailEvent, type TransitionContext, type TransitionResult } from "@ephyra/core";

export type TransitionFn = (trail: Trail, event: TrailEvent, ctx: TransitionContext) => TransitionResult;
export interface PolicyPort {
  context(trail: Trail, event: TrailEvent): Promise<TransitionContext>;
}
export type EffectHandlers = { [K in Effect["type"]]: (effect: Extract<Effect, {type: K}>, trail: Trail) => Promise<void> };
type Operation = "running" | "complete" | "reconciliation_required";

/** In-process development engine. State and pending operations are lost on restart. */
export class LocalOrchestrator {
  readonly trails = new Map<string, Trail>();
  readonly events = new Map<string, TrailEvent>();
  readonly operations = new Map<string, Operation>();
  readonly outbox: { trail: Trail; event: TrailEvent; effects: Effect[]; published: boolean; dispatched: boolean }[] = [];
  constructor(private transition: TransitionFn, private policy: PolicyPort, private handlers: EffectHandlers) {}
  async apply(event: TrailEvent): Promise<void> {
    if (this.events.has(event.id)) return;
    const trail = this.trails.get(event.trail);
    if (!trail) throw new Error("trail not found");
    const result = this.transition(trail, event, await this.policy.context(trail, event));
    if (!result.ok) throw new Error(result.error);
    this.trails.set(trail.id, result.trail);
    this.events.set(event.id, event);
    this.outbox.push({ trail: result.trail, event, effects: result.effects, published: false, dispatched: false });
  }
  async execute(effect: Effect, trail: Trail): Promise<void> {
    const state = this.operations.get(effect.key);
    if (state === "complete") return;
    if (state) throw new ReconciliationRequired(effect.key, `operation is ${state}`);
    this.operations.set(effect.key, "running");
    try {
      const handler = this.handlers[effect.type] as (effect: Effect, trail: Trail) => Promise<void>;
      await handler(effect, trail);
      this.operations.set(effect.key, "complete");
    } catch (error) {
      // A generic failure may also have happened after an external write.
      this.operations.set(effect.key, "reconciliation_required");
      throw error;
    }
  }
  async publish(journal: Journal): Promise<void> {
    for (const row of this.outbox) {
      if (!row.published) await this.publishRow(journal, row);
      if (!row.dispatched) {
        for (const effect of row.effects) await this.execute(effect, row.trail);
        row.dispatched = true;
      }
    }
  }

  private async publishRow(journal: Journal, row: (typeof this.outbox)[number]): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await journal.read(row.trail.id);
      if (current?.events.some((event) => event.id === row.event.id)) {
        row.published = true;
        return;
      }
      if (current) {
        const result = this.transition(current.trail, row.event, await this.policy.context(current.trail, row.event));
        if (!result.ok) throw new Error(result.error);
        row.trail = result.trail;
        row.effects = result.effects;
      }
      try {
        if (current) await journal.append(row.trail.id, current.head, row.trail, [row.event]);
        else await journal.create(row.trail, row.event);
        this.trails.set(row.trail.id, row.trail);
        row.published = true;
        return;
      } catch (error) {
        const after = await journal.read(row.trail.id);
        // Only a changed head proves a conflict; other failures may be ambiguous.
        if (after?.head === current?.head || (!after && !current)) throw error;
      }
    }
    throw new Error("journal conflict retry limit exceeded");
  }
}
