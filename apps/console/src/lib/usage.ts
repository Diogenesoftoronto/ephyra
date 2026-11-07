// Usage arithmetic. Unknown cost (null) is counted, never folded into a total as zero.
import {
  PERSONAS,
  personaFor,
  type PersonaId,
  type UsageEntry,
  type UsageSummary,
  type UsageTotals,
} from "@ephyra/core";

export const emptyTotals = (): UsageTotals => ({
  entries: 0,
  costMicrousd: 0,
  unknownCost: 0,
  tokens: 0,
  wallMs: 0,
  failed: 0,
  unavailable: 0,
});

export function addEntry(t: UsageTotals, e: UsageEntry): UsageTotals {
  return {
    entries: t.entries + 1,
    costMicrousd: t.costMicrousd + (e.costMicrousd ?? 0),
    unknownCost: t.unknownCost + (e.costMicrousd === null ? 1 : 0),
    tokens: t.tokens + (e.tokens ?? 0),
    wallMs: t.wallMs + (e.wallMs ?? 0),
    failed: t.failed + (e.outcome === "failed" ? 1 : 0),
    unavailable: t.unavailable + (e.outcome === "unavailable" ? 1 : 0),
  };
}

export const totalsOf = (entries: readonly UsageEntry[]): UsageTotals =>
  entries.reduce(addEntry, emptyTotals());

export type UsageFilter = {
  from?: string;
  to?: string;
  persona?: PersonaId | "unattributed";
  engine?: string;
  trail?: string;
};

export function filterEntries(entries: readonly UsageEntry[], f: UsageFilter): UsageEntry[] {
  return entries.filter((e) => {
    if (f.from && e.at < f.from) return false;
    if (f.to && e.at > f.to) return false;
    if (f.persona && (f.persona === "unattributed" ? personaOf(e) !== null : personaOf(e) !== f.persona))
      return false;
    if (f.engine && e.engine !== f.engine) return false;
    if (f.trail && e.trailId !== f.trail) return false;
    return true;
  });
}

function groupBy<K extends string | null>(
  entries: readonly UsageEntry[],
  key: (e: UsageEntry) => K,
): Array<{ key: K; totals: UsageTotals }> {
  const map = new Map<K, UsageTotals>();
  for (const e of entries) map.set(key(e), addEntry(map.get(key(e)) ?? emptyTotals(), e));
  return [...map].map(([k, totals]) => ({ key: k, totals }));
}

/** The persona an entry belongs to: its recorded persona, else the one that owns its step, else unattributed. */
export const personaOf = (e: UsageEntry): PersonaId | null => e.persona ?? personaFor(e.step);

export type TrailMeta = {
  trailId: string;
  short: string;
  title: string;
  budget: UsageSummary["byTrail"][number]["budget"];
};

export function summarize(
  entries: readonly UsageEntry[],
  from: string,
  to: string,
  trails: readonly TrailMeta[],
): UsageSummary {
  const days: string[] = [];
  for (let t = Date.parse(`${from.slice(0, 10)}T00:00:00Z`); t <= Date.parse(to); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  const byDay = groupBy(entries, (e) => e.at.slice(0, 10));
  const order = new Map(PERSONAS.map((p, i) => [p.id as string | null, i]));
  return {
    from,
    to,
    totals: totalsOf(entries),
    byPersona: groupBy(entries, personaOf).sort(
      (a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99),
    ),
    byEngine: groupBy(entries, (e) => e.engine).sort((a, b) => b.totals.costMicrousd - a.totals.costMicrousd),
    byTrail: trails
      .flatMap((t) => {
        const mine = entries.filter((e) => e.trailId === t.trailId);
        return mine.length ? [{ ...t, totals: totalsOf(mine) }] : [];
      })
      .sort((a, b) => b.totals.costMicrousd - a.totals.costMicrousd),
    byDay: days.map((d) => ({ key: d, totals: byDay.find((g) => g.key === d)?.totals ?? emptyTotals() })),
  };
}
