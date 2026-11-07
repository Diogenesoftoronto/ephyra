// Usage ledger: storage (memory + Convex), recording helpers, and the pure aggregation behind /v1/usage.
// Unknown cost is null and is counted in `unknownCost`; it is never folded into a total as zero.
import {
  UsageEntry, personaFor, type PersonaId, type UsageEntry as Entry, type UsageSummary, type UsageTotals,
} from "@ephyra/core";
import type { UsageHook } from "@ephyra/models";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

export interface UsageStore {
  record(entry: Entry): Promise<void>;
  list(): Promise<Entry[]>;
}
export class MemoryUsageStore implements UsageStore {
  private entries = new Map<string, Entry>();
  async record(entry: Entry): Promise<void> {
    const valid = UsageEntry.parse(entry);
    if (!this.entries.has(valid.idempotencyKey)) this.entries.set(valid.idempotencyKey, valid);
  }
  async list(): Promise<Entry[]> { return [...this.entries.values()].map((entry) => UsageEntry.parse(entry)); }
}
export class ConvexUsageStore implements UsageStore {
  constructor(private client: ConvexHttpClient, private secret: string) {}
  async record(entry: Entry): Promise<void> {
    const valid = UsageEntry.parse(entry);
    await this.client.mutation(api.usage.record, { secret: this.secret, key: valid.idempotencyKey, json: JSON.stringify(valid) });
  }
  async list(): Promise<Entry[]> {
    return (await this.client.query(api.usage.list, { secret: this.secret })).map((row) => UsageEntry.parse(JSON.parse(row)));
  }
}

// ───────────────────────── Aggregation ─────────────────────────

export const EMPTY_TOTALS: UsageTotals = { entries: 0, costMicrousd: 0, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 };

export function addEntry(t: UsageTotals, entry: Entry): UsageTotals {
  return {
    entries: t.entries + 1, costMicrousd: t.costMicrousd + (entry.costMicrousd ?? 0),
    unknownCost: t.unknownCost + Number(entry.costMicrousd === null), tokens: t.tokens + (entry.tokens ?? 0),
    wallMs: t.wallMs + (entry.wallMs ?? 0), failed: t.failed + Number(entry.outcome === "failed"),
    unavailable: t.unavailable + Number(entry.outcome === "unavailable"),
  };
}
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    entries: a.entries + b.entries, costMicrousd: a.costMicrousd + b.costMicrousd, unknownCost: a.unknownCost + b.unknownCost,
    tokens: a.tokens + b.tokens, wallMs: a.wallMs + b.wallMs, failed: a.failed + b.failed, unavailable: a.unavailable + b.unavailable,
  };
}
export function usageTotals(entries: Entry[]): UsageTotals { return entries.reduce(addEntry, EMPTY_TOTALS); }

export const DAY_MS = 86_400_000;
export const MAX_WINDOW_DAYS = 366;
export const DEFAULT_WINDOW_DAYS = 7;

export type UsageFilter = {
  from: Date;
  to: Date;
  /** A persona id, or "unattributed" for entries that belong to no persona. */
  persona?: PersonaId | "unattributed";
  engine?: string;
  /** A trail id or its short name. */
  trail?: string;
};
/** What the summary needs to know about a trail; entries for trails the projection no longer knows are still counted. */
export type TrailInfo = {
  id: string; short: string; title: string;
  budget: { spendMicrousdUsed: number; spendMicrousdMax: number; tokensUsed: number; tokensMax: number };
};

export function filterEntries(entries: Entry[], f: UsageFilter): Entry[] {
  const from = f.from.getTime();
  const to = f.to.getTime();
  return entries.filter((e) => {
    const at = Date.parse(e.at);
    if (at < from || at > to) return false;
    if (f.persona && (f.persona === "unattributed" ? e.persona !== null : e.persona !== f.persona)) return false;
    if (f.engine && e.engine !== f.engine) return false;
    if (f.trail && e.trailId !== f.trail && e.short !== f.trail) return false;
    return true;
  });
}

function groupBy<K extends string | null>(entries: Entry[], key: (e: Entry) => K): { key: K; totals: UsageTotals }[] {
  const groups = new Map<K, UsageTotals>();
  for (const e of entries) groups.set(key(e), addEntry(groups.get(key(e)) ?? EMPTY_TOTALS, e));
  return [...groups].map(([k, totals]) => ({ key: k, totals }))
    .sort((a, b) => b.totals.entries - a.totals.entries || String(a.key).localeCompare(String(b.key)));
}

/** One UTC-day key per day from `from` to `to` inclusive, oldest first. */
export function utcDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (let t = Math.floor(from.getTime() / DAY_MS) * DAY_MS; t <= to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

export function summarizeUsage(all: Entry[], filter: UsageFilter, trails: ReadonlyMap<string, TrailInfo>): UsageSummary {
  const entries = filterEntries(all, filter);
  const byDayMap = new Map(groupBy(entries, (e) => e.at.slice(0, 10)).map((g) => [g.key, g.totals]));
  const trailGroups = groupBy(entries.filter((e) => e.trailId !== null), (e) => e.trailId!);
  return {
    from: filter.from.toISOString(), to: filter.to.toISOString(), totals: usageTotals(entries),
    byPersona: groupBy(entries, (e) => e.persona),
    byEngine: groupBy(entries, (e) => e.engine),
    byTrail: trailGroups.map(({ key, totals }) => {
      const info = trails.get(key);
      const short = info?.short ?? entries.find((e) => e.trailId === key)?.short ?? key.slice(0, 8);
      return {
        trailId: key, short, title: info?.title ?? "(trail not in the projection)", totals,
        budget: info?.budget ?? { spendMicrousdUsed: totals.costMicrousd, spendMicrousdMax: 0, tokensUsed: totals.tokens, tokensMax: 0 },
      };
    }),
    byDay: utcDays(filter.from, filter.to).map((key) => ({ key, totals: byDayMap.get(key) ?? EMPTY_TOTALS })),
  };
}

export type BilledTo = Entry["billedTo"];
export class BadCursor extends Error {}
const newestFirst = (a: Entry, b: Entry) => (a.at === b.at ? (a.id === b.id ? 0 : a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1);

/** Newest first; the cursor is the (at, id) of the last returned entry, so pages stay stable while new entries arrive. */
export function pageEntries(all: Entry[], filter: UsageFilter, opts: { limit: number; cursor?: string }): { entries: Entry[]; cursor?: string } {
  let rows = filterEntries(all, filter).sort(newestFirst);
  if (opts.cursor) {
    const [at, id] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("\n");
    if (!at || id === undefined || Number.isNaN(Date.parse(at))) throw new BadCursor("invalid cursor");
    const after = { at, id } as Entry;
    rows = rows.filter((e) => newestFirst(after, e) < 0);
  }
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return { entries: page, ...(rows.length > page.length && last ? { cursor: Buffer.from(`${last.at}\n${last.id}`).toString("base64url") } : {}) };
}

// ───────────────────────── Recording ─────────────────────────

/** Short, human-readable, and free of anything that looks like a credential. */
export function safeNote(text: string, max = 300): string {
  return text.replace(/\s+/g, " ")
    .replace(/\b(Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]")
    .replace(/(["']?[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization)[\w-]*["']?)\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[a-z]|eyJ)[-_A-Za-z0-9.]{10,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, "[redacted]")
    .trim().slice(0, max);
}

const MODEL_STEPS: Record<string, { kind: "extract" | "triage"; step: string }> = {
  extract: { kind: "extract", step: "extract" },
  "decide.triage": { kind: "triage", step: "triage" },
  "decide.policy": { kind: "triage", step: "policy" },
  "decide.watch": { kind: "triage", step: "watch" },
};

export type UsageInput = Omit<Entry, "id" | "at" | "note"> & { at?: Date; note?: string };

/** Writes ledger rows. Recording never throws: a ledger outage must not fail the work being measured. */
export class UsageRecorder {
  constructor(
    private readonly store: UsageStore,
    private readonly log: (msg: string, fields?: Record<string, unknown>) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: UsageInput): Promise<void> {
    const { at, note, ...rest } = input;
    try {
      await this.store.record(UsageEntry.parse({
        ...rest, id: input.idempotencyKey, at: (at ?? this.now()).toISOString(), ...(note ? { note: safeNote(note) } : {}),
      }));
    } catch (error) {
      this.log("usage record failed", { key: input.idempotencyKey, error: safeNote(String(error)) });
    }
  }

  /** The `UsageHook` for `@ephyra/models` backends: one row per successful model call, keyed by the call's idempotency key. */
  modelHook(billedTo: BilledTo): UsageHook {
    return async (r) => {
      const mapped = MODEL_STEPS[r.purpose] ?? { kind: "triage" as const, step: r.purpose };
      await this.record({
        idempotencyKey: `model:${r.purpose}:${r.idempotencyKey}`, kind: mapped.kind, persona: personaFor(mapped.step), step: mapped.step,
        engine: r.identity, trailId: null, short: null, tokens: r.tokens, costMicrousd: r.costMicrousd, wallMs: null, outcome: "ok", billedTo,
      });
    };
  }
}
