import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { UsageSummary } from "@ephyra/core";
import { coverage, drivers, forecastCumulative, lastCompleteDay, outcomes, paceSeries } from "./usage-charts.ts";

const totals = fc.record({
  entries: fc.integer({ min: 0, max: 50 }), costMicrousd: fc.integer({ min: 0, max: 5_000_000 }),
  unknownCost: fc.integer({ min: 0, max: 50 }), tokens: fc.integer({ min: 0, max: 1e6 }), wallMs: fc.integer({ min: 0, max: 1e7 }),
  failed: fc.integer({ min: 0, max: 50 }), unavailable: fc.integer({ min: 0, max: 50 }),
}).map((t) => ({ ...t, unknownCost: Math.min(t.unknownCost, t.entries), failed: Math.min(t.failed, t.entries),
  unavailable: Math.min(t.unavailable, Math.max(0, t.entries - Math.min(t.failed, t.entries))) }));
const day = (i: number) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
const byDay = fc.array(totals, { minLength: 1, maxLength: 14 }).map((ts) => ts.map((t, i) => ({ key: day(i), totals: t })));

describe("usage charts", () => {
  test("cumulative pace is monotone and ends at the window total", () => {
    fc.assert(fc.property(byDay, (days) => {
      const pace = paceSeries(days as UsageSummary["byDay"], days.at(-1)!.key);
      for (let i = 1; i < pace.length; i++) expect(pace[i]!.cumulative).toBeGreaterThanOrEqual(pace[i - 1]!.cumulative);
      expect(pace.at(-1)!.cumulative).toBe(days.reduce((n, d) => n + d.totals.costMicrousd, 0));
      expect(pace.filter((p) => p.partial)).toHaveLength(1);
    }));
  });
  test("forecast continues from its own history end, never from today's partial spend", () => {
    const pace = paceSeries([{ key: day(0), totals: { entries: 1, costMicrousd: 100, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 } },
      { key: day(1), totals: { entries: 1, costMicrousd: 900, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 } }], day(1));
    const out = forecastCumulative(pace, { status: "ok", engine: "e", requestedModel: "m", operationKey: "k", pNull: null, receipt: { tokens: null, costMicrousd: null },
      basis: { from: day(0), to: day(0), completeDays: 7, daysWithPricedSpend: 3, pricedEntries: 1, unknownCostEntries: 0, failedEntries: 0, excludedPartialDay: day(1) },
      days: [{ day: day(1), median: 50, p10: 10, p90: null }, { day: day(2), median: 50, p10: 10, p90: 90 }] });
    expect(out.map((p) => p.median)).toEqual([150, 200]);
    expect(out.map((p) => p.low)).toEqual([110, 120]);
    expect(out.map((p) => p.high)).toEqual([null, null]);
  });
  test("drivers keep every group's cost and unknown count", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.string({ maxLength: 6 }), totals), { maxLength: 12 }), fc.integer({ min: 2, max: 8 }), (rows, limit) => {
      const groups = rows.map(([k, t], i) => ({ key: `${k}${i}`, totals: t }));
      const { top, rest } = drivers(groups, limit);
      const all = [...top, ...(rest ? [rest] : [])];
      expect(all.reduce((n, d) => n + d.cost, 0)).toBe(groups.reduce((n, g) => n + g.totals.costMicrousd, 0));
      expect(all.reduce((n, d) => n + d.unknown, 0)).toBe(groups.reduce((n, g) => n + g.totals.unknownCost, 0));
      expect(all.length).toBeLessThanOrEqual(Math.max(limit, groups.length <= limit ? groups.length : limit));
      const shares = all.reduce((n, d) => n + d.share, 0);
      if (all.some((d) => d.cost > 0)) expect(Math.abs(shares - 1)).toBeLessThan(1e-9);
    }));
  });
  test("outcomes partition entries; coverage is null without entries", () => {
    fc.assert(fc.property(byDay, (days) => {
      for (const [i, o] of outcomes(days as UsageSummary["byDay"], "x").entries()) {
        expect(o.ok + o.failed + o.unavailable).toBe(days[i]!.totals.entries);
        expect(o.priced + o.unknown).toBe(days[i]!.totals.entries);
      }
    }));
    expect(coverage({ entries: 0, costMicrousd: 0, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 })).toBeNull();
    expect(lastCompleteDay(Date.parse("2026-11-11T15:00:00Z"))).toBe("2026-11-10");
  });
});
