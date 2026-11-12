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

export const EFFECT_HISTORY_PATH = "outbox/history.json";
const MAX_HISTORY = 500;

/**
 * Every effect a transition asked for, with the event that caused it. It records intent, in order, so a reader can see
 * what the engine set in motion. It says nothing about delivery: the operation ledger is the only record of that.
 */
export type RecordedEffect = { cause: string; effect: Effect };

/** The newest `MAX_HISTORY` effects, one entry per operation key. */
export function recordEffects(history: readonly RecordedEffect[], cause: string, effects: readonly Effect[]): RecordedEffect[] {
  const entries = [...history];
  const keys = new Set(entries.map(entry => entry.effect.key));
  for (const raw of effects) {
    const effect = EffectSchema.parse(raw);
    if (keys.has(effect.key)) continue;
    keys.add(effect.key);
    entries.push({ cause, effect });
  }
  return entries.slice(-MAX_HISTORY);
}

export const effectHistory = (entries: readonly RecordedEffect[]): string => canonicalJson({ schema: 1, effects: entries });

/** Journals written before the history existed read as empty. Past effects are never re-derived from events. */
export async function readEffectHistory(journal: Journal, trailId: string): Promise<RecordedEffect[]> {
  const bytes = await journal.readFile(trailId, EFFECT_HISTORY_PATH);
  if (!bytes) return [];
  try {
    if (bytes.byteLength > MAX_BYTES) throw new Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value?.schema !== 1 || !Array.isArray(value.effects) || value.effects.length > MAX_HISTORY) throw new Error();
    return value.effects.map((entry: RecordedEffect) => {
      if (!entry || typeof entry.cause !== "string" || entry.cause.length > 64) throw new Error();
      return { cause: entry.cause, effect: EffectSchema.parse(entry.effect) };
    });
  } catch { throw new Unverified("corrupt effect history"); }
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
