import type { Trail, UsageSummary } from "@ephyra/core";

/**
 * Cost per landed quest, week by week: what it took, in recorded spend, to get one fix landed. The spend of quests that
 * ended without landing in a week is charged to that week's landings, so dropping dead ends from the count can never
 * make the number look better. Weeks with no landing have no value; they are never drawn as zero.
 */
export type CostTrail = Pick<Trail, "id" | "state" | "updatedAt" | "budget"> & {
  landing?: { receipts: readonly { at: string }[] };
};

export interface WeekCost {
  /** Monday of the UTC week, YYYY-MM-DD. */
  week: string;
  landed: number;
  landedSpend: number;
  deadEnds: number;
  deadEndSpend: number;
  /** (landed + dead-end spend) / landed, microusd. Null when nothing landed that week. */
  perLanded: number | null;
}

const DAY = 86_400_000;
export function weekStart(ms: number): number {
  const day = Math.floor(ms / DAY) * DAY;
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * DAY;
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** When the quest landed: its first landing receipt. A quest without one did not land, whatever its state. */
export function landedAt(t: CostTrail): number | null {
  const times = (t.landing?.receipts ?? []).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

export function weeklyCost(trails: readonly CostTrail[], now: number, weeks = 12): WeekCost[] {
  const last = weekStart(now);
  const first = last - (weeks - 1) * 7 * DAY;
  const out: WeekCost[] = Array.from({ length: weeks }, (_, i) => ({
    week: iso(first + i * 7 * DAY), landed: 0, landedSpend: 0, deadEnds: 0, deadEndSpend: 0, perLanded: null,
  }));
  const slot = (ms: number) => {
    const w = weekStart(ms);
    if (w < first || w > last) return null;
    return out[Math.round((w - first) / (7 * DAY))]!;
  };
  for (const t of trails) {
    const spend = Math.max(0, t.budget.spendMicrousdUsed);
    const at = landedAt(t);
    if (at !== null) {
      const s = slot(at);
      if (s) { s.landed += 1; s.landedSpend += spend; }
    } else if (t.state === "closed" || t.state === "abandoned") {
      const s = slot(Date.parse(t.updatedAt));
      if (s) { s.deadEnds += 1; s.deadEndSpend += spend; }
    }
  }
  for (const w of out) w.perLanded = w.landed ? Math.round((w.landedSpend + w.deadEndSpend) / w.landed) : null;
  return out;
}

export interface CostTrend {
  /** Least-squares fit over weeks with a value. */
  direction: "down" | "up" | "flat" | "unknown";
  /** Fitted change from the first to the last week with a value, as a share (-0.4 = 40% cheaper). */
  change: number | null;
  points: number;
  latest: number | null;
  /** Spend-weighted cost per landed quest across the whole period. */
  overall: number | null;
  landed: number;
}

/** Fewer than this many weeks with landings is not a trend, and the page says so instead of drawing a claim. */
export const MIN_TREND_POINTS = 3;
const FLAT = 0.05;

export function costTrend(weeks: readonly WeekCost[]): CostTrend {
  const pts = weeks.map((w, i) => ({ x: i, y: w.perLanded })).filter((p): p is { x: number; y: number } => p.y !== null);
  const landed = weeks.reduce((n, w) => n + w.landed, 0);
  const spend = weeks.reduce((n, w) => n + w.landedSpend + w.deadEndSpend, 0);
  const overall = landed ? Math.round(spend / landed) : null;
  const latest = pts.at(-1)?.y ?? null;
  if (pts.length < MIN_TREND_POINTS) return { direction: "unknown", change: null, points: pts.length, latest, overall, landed };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = sxx ? pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  const start = my + slope * (pts[0]!.x - mx);
  const end = my + slope * (pts.at(-1)!.x - mx);
  const change = start > 0 ? Math.max(-1, (end - start) / start) : null;
  const direction = change === null ? "unknown" : change <= -FLAT ? "down" : change >= FLAT ? "up" : "flat";
  return { direction, change, points: n, latest, overall, landed };
}

export interface Outlook {
  horizon: number;
  /** Recorded priced spend per day over the history. */
  daily: number;
  expected: number;
  /** The same horizon at the quietest and busiest full week's pace in the history. */
  low: number;
  high: number;
  historyDays: number;
  unknownCost: number;
}
/**
 * A plain pace projection for horizons the model forecast does not cover. It multiplies recorded daily spend and
 * brackets it with the quietest and busiest week in the history. It is arithmetic on your own ledger, labelled as
 * such, not a prediction. Today's partial day is left out.
 */
export function outlook(days: UsageSummary["byDay"], today: string, horizon: number): Outlook | null {
  const complete = days.filter((d) => d.key < today);
  if (complete.length < 7) return null;
  const spend = complete.map((d) => d.totals.costMicrousd);
  const daily = spend.reduce((a, b) => a + b, 0) / complete.length;
  const weekly: number[] = [];
  for (let i = complete.length - 7; i >= 0; i -= 7) weekly.push(spend.slice(i, i + 7).reduce((a, b) => a + b, 0) / 7);
  return {
    horizon, daily, expected: Math.round(daily * horizon),
    low: Math.round(Math.min(...weekly) * horizon), high: Math.round(Math.max(...weekly) * horizon),
    historyDays: complete.length, unknownCost: complete.reduce((n, d) => n + d.totals.unknownCost, 0),
  };
}
