import { SQL } from "bun";
import { Trail, TrailEvent, Effect, Unverified, type Journal } from "@ephyra/core";
import type { PolicyPort, TransitionFn } from "../orchestrator.ts";
import type { EffectExecutor } from "../orchestrator/effects.ts";
import { canonicalJson } from "../audit.ts";

function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** One unpublished event per trail prevents later projections from being overwritten on CAS replay. */
export class PgOrchestrator {
  constructor(
    private readonly sql: SQL,
    private readonly transition: TransitionFn,
    private readonly policy: PolicyPort,
    private readonly journal: Journal,
    private readonly executor: EffectExecutor,
  ) {}

  async seed(trail: Trail): Promise<void> {
    const valid = Trail.parse(trail);
    await this.sql`INSERT INTO trail_projection (id, state, trail)
      VALUES (${valid.id}, ${valid.state}, ${JSON.stringify(valid)}::jsonb)`;
  }

  async apply(event: TrailEvent): Promise<void> {
    const valid = TrailEvent.parse(event);
    await this.sql.begin(async (tx) => {
      const projections = await tx`SELECT trail FROM trail_projection WHERE id = ${valid.trail} FOR UPDATE`;
      if (!projections.length) throw new Error("trail not found");
      const existing = await tx`SELECT event FROM event_inbox WHERE id = ${valid.id}`;
      if (existing.length) {
        if (canonicalJson(json(existing[0].event)) !== canonicalJson(valid)) throw new Error("event id reused");
        return;
      }
      const pending = await tx`SELECT id FROM outbox WHERE trail_id = ${valid.trail} AND published_at IS NULL LIMIT 1`;
      if (pending.length) throw new Error("trail has an unpublished event");
      const trail = Trail.parse(json(projections[0].trail));
      const result = this.transition(trail, valid, await this.policy.context(trail, valid));
      if (!result.ok) throw new Error(result.error);
      await tx`INSERT INTO event_inbox (id, trail_id, event) VALUES (${valid.id}, ${valid.trail}, ${JSON.stringify(valid)}::jsonb)`;
      await tx`UPDATE trail_projection SET state = ${result.trail.state}, trail = ${JSON.stringify(result.trail)}::jsonb
        WHERE id = ${valid.trail}`;
      await tx`INSERT INTO outbox (id, trail_id, event, trail, effects)
        VALUES (${valid.id}, ${valid.trail}, ${JSON.stringify(valid)}::jsonb, ${JSON.stringify(result.trail)}::jsonb,
          ${JSON.stringify(result.effects)}::jsonb)`;
    });
  }

  async publish(id: string): Promise<void> {
    const result = await this.sql.begin(async (tx) => {
      const rows = await tx`SELECT * FROM outbox WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw new Error("outbox row not found");
      const row = rows[0];
      let trail = Trail.parse(json(row.trail));
      let effects = Effect.array().parse(json(row.effects));
      const event = TrailEvent.parse(json(row.event));
      if (!row.published_at) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const current = await this.journal.read(event.trail);
          if (current?.events.some((item) => item.id === event.id)) {
            if (canonicalJson(current.trail) !== canonicalJson(trail)) {
              throw new Unverified("outbox recovery after journal projection changed");
            }
            break;
          }
          if (current) {
            const next = this.transition(current.trail, event, await this.policy.context(current.trail, event));
            if (!next.ok) throw new Error(next.error);
            trail = next.trail;
            effects = next.effects;
          }
          try {
            if (current) await this.journal.append(event.trail, current.head, trail, [event]);
            else await this.journal.create(trail, event);
            break;
          } catch (error) {
            const after = await this.journal.read(event.trail);
            if ((!after && !current) || after?.head === current?.head) throw error;
            if (attempt === 9) throw new Error("journal conflict retry limit exceeded");
          }
        }
        await tx`UPDATE outbox SET trail = ${JSON.stringify(trail)}::jsonb, effects = ${JSON.stringify(effects)}::jsonb,
          published_at = now() WHERE id = ${id}`;
        await tx`UPDATE trail_projection SET trail = ${JSON.stringify(trail)}::jsonb, state = ${trail.state} WHERE id = ${trail.id}`;
      }
      return { trail, effects, dispatched: !!row.dispatched_at };
    });
    if (result.dispatched) return;
    for (const effect of result.effects) await this.executor.execute(effect, result.trail);
    await this.sql`UPDATE outbox SET dispatched_at = now() WHERE id = ${id}`;
  }
}
