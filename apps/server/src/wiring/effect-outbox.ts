import { Effect as EffectSchema, Trail as TrailSchema, Unverified, type Effect, type Journal, type Trail } from "@ephyra/core";
import { canonicalJson } from "../audit.ts";

export const EFFECT_OUTBOX_PATH = "outbox/pending.json";
const MAX_ENTRIES = 1000;
const MAX_BYTES = 8_000_000;

/** The snapshot is immutable: the operation ledger binds its digest, not a later projection of the trail. */
export type PendingEffect = { eventId: string; effect: Effect; trail: Trail };

export function effectOutbox(entries: PendingEffect[]): string {
  if (entries.length > MAX_ENTRIES) throw new Unverified("effect outbox capacity; reconcile blocked operations");
  const text = canonicalJson({ schema: 1, pending: entries });
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Unverified("bounded effect outbox");
  return text;
}

export async function readEffectOutbox(journal: Journal, trailId: string): Promise<PendingEffect[]> {
  const bytes = await journal.readFile(trailId, EFFECT_OUTBOX_PATH);
  if (!bytes) return []; // Existing journals predate the durable outbox; never infer historical external writes.
  try {
    if (bytes.byteLength > MAX_BYTES) throw new Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value?.schema !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_ENTRIES) throw new Error();
    const keys = new Set<string>();
    return value.pending.map((entry: PendingEffect) => {
      if (!entry || typeof entry.eventId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entry.eventId)) {
        throw new Error();
      }
      const trail = TrailSchema.parse(entry.trail);
      const effect = EffectSchema.parse(entry.effect);
      if (trail.id !== trailId || keys.has(effect.key)) throw new Error();
      keys.add(effect.key);
      return { eventId: entry.eventId, trail, effect };
    });
  } catch { throw new Unverified("corrupt durable effect outbox"); }
}

export function appendEffects(pending: PendingEffect[], eventId: string, trail: Trail, effects: Effect[]): PendingEffect[] {
  const entries = [...pending];
  const snapshot = TrailSchema.parse(trail);
  for (const raw of effects) {
    const entry = { eventId, trail: snapshot, effect: EffectSchema.parse(raw) };
    const previous = entries.find(value => value.effect.key === entry.effect.key);
    if (previous && canonicalJson(previous) !== canonicalJson(entry)) throw new Unverified("effect operation key changed its durable plan");
    if (!previous) entries.push(entry);
  }
  effectOutbox(entries); // Validate the entire write before acknowledging its event.
  return entries;
}

const WORK_EFFECTS = new Set<Effect["type"]>([
  "run_triage", "start_agent", "run_proof", "request_checkpoint", "request_spend", "land", "rebase", "start_watch", "rollback", "stop_agent",
]);

/** Never revive superseded work just because its projection or dispatch failed before a later cancellation. */
export function effectIsCurrent(entry: PendingEffect, current: Trail): boolean {
  if (!WORK_EFFECTS.has(entry.effect.type)) return true;
  const old = entry.trail;
  return old.rev === current.rev && old.head === current.head && old.base.sha === current.base.sha
    && old.state === current.state && old.policyCommit === current.policyCommit && old.workGeneration === current.workGeneration
    && (entry.effect.type !== "request_spend" || canonicalJson(old.pendingSpend ?? null) === canonicalJson(current.pendingSpend ?? null));
}
