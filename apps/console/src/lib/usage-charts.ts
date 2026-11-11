// Pure series for the Usage charts. Unknown costs are never zero: they are counted beside the priced amounts.
import type { UsageForecast, UsageSummary } from "@ephyra/core";

export type PacePoint = { day: string; daily: number; cumulative: number; unknown: number; partial: boolean };
/** Cumulative priced spend per UTC day. The last day is partial when it is today. */
export function paceSeries(days: UsageSummary["byDay"], today: string): PacePoint[] {
  let running = 0;
  return days.map((d) => {
    running += d.totals.costMicrousd;
    return { day: d.key, daily: d.totals.costMicrousd, cumulative: running, unknown: d.totals.unknownCost, partial: d.key === today };
  });
}

export type ForecastPoint = { day: string; median: number; low: number | null; high: number | null };
/**
 * Preserve the provider's daily distribution. Daily quantiles cannot be added to obtain a cumulative quantile without
 * knowing the joint distribution, so the forecast is drawn per day, separately from the recorded running total.
 */
export function forecastDaily(forecast: Extract<UsageForecast, { status: "ok" }>): ForecastPoint[] {
  return forecast.days.map((d) => ({ day: d.day, median: d.median, low: d.p10, high: d.p90 }));
}

export type Driver = { key: string; cost: number; share: number; unknown: number; entries: number };
/** Largest priced cost first; groups with only unknown cost stay listed with share 0, never hidden. */
export function drivers(groups: readonly { key: string | null; totals: UsageSummary["totals"] }[], limit = 6): { top: Driver[]; rest: Driver | null } {
  const total = groups.reduce((n, g) => n + g.totals.costMicrousd, 0);
  const all = groups.map((g) => ({ key: g.key ?? "unattributed", cost: g.totals.costMicrousd, unknown: g.totals.unknownCost,
    entries: g.totals.entries, share: total > 0 ? g.totals.costMicrousd / total : 0 }))
    .sort((a, b) => b.cost - a.cost || b.unknown - a.unknown || a.key.localeCompare(b.key));
  if (all.length <= limit) return { top: all, rest: null };
  const tail = all.slice(limit - 1);
  return {
    top: all.slice(0, limit - 1),
    rest: { key: `${tail.length} others`, cost: tail.reduce((n, d) => n + d.cost, 0), share: tail.reduce((n, d) => n + d.share, 0),
      unknown: tail.reduce((n, d) => n + d.unknown, 0), entries: tail.reduce((n, d) => n + d.entries, 0) },
  };
}

export type OutcomeDay = { day: string; ok: number; failed: number; unavailable: number; priced: number; unknown: number; partial: boolean };
/** Per-day outcomes (ok / failed / unavailable) and cost coverage (priced / unknown). */
export function outcomes(days: UsageSummary["byDay"], today: string): OutcomeDay[] {
  return days.map((d) => ({
    day: d.key,
    failed: d.totals.failed,
    unavailable: d.totals.unavailable,
    ok: Math.max(0, d.totals.entries - d.totals.failed - d.totals.unavailable),
    unknown: d.totals.unknownCost,
    priced: Math.max(0, d.totals.entries - d.totals.unknownCost),
    partial: d.key === today,
  }));
}
/** Share of entries with a recorded price, or null when there were no entries. */
export function coverage(totals: UsageSummary["totals"]): number | null {
  return totals.entries ? (totals.entries - totals.unknownCost) / totals.entries : null;
}
/** The last complete UTC day before `now`. */
export function lastCompleteDay(now: number): string {
  return new Date(Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
}
