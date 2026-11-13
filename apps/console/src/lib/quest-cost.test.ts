import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { costTrend, landedAt, MIN_TREND_POINTS, outlook, weekStart, weeklyCost, type CostTrail, type WeekCost } from "./quest-cost.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const DAY = 86_400_000;
const at = fc.integer({ min: NOW - 120 * DAY, max: NOW }).map((t) => new Date(t).toISOString());
const trail: fc.Arbitrary<CostTrail> = fc.record({
  id: fc.uuid(), state: fc.constantFrom("closed" as const, "abandoned" as const, "patching" as const, "watching" as const),
  updatedAt: at,
  budget: fc.record({ tokensUsed: fc.nat(), tokensMax: fc.nat(), spendMicrousdUsed: fc.nat(20_000_000), spendMicrousdMax: fc.nat() }),
  landing: fc.option(fc.record({ receipts: fc.array(fc.record({ at }), { maxLength: 2 }) }), { nil: undefined }),
});

describe("cost per landed quest", () => {
  test("weeks start on Monday and cover the window without gaps", () => {
    const w = weeklyCost([], NOW, 12);
    expect(w).toHaveLength(12);
    for (const x of w) expect(new Date(`${x.week}T00:00:00Z`).getUTCDay()).toBe(1);
    for (let i = 1; i < w.length; i++) expect(Date.parse(w[i]!.week) - Date.parse(w[i - 1]!.week)).toBe(7 * DAY);
    expect(Date.parse(w.at(-1)!.week)).toBe(weekStart(NOW));
  });

  test("every landed quest is counted once, in the week of its first receipt, and dead ends only add cost", () => {
    fc.assert(fc.property(fc.uniqueArray(trail, { selector: (t) => t.id, maxLength: 30 }), (trails) => {
      const weeks = weeklyCost(trails, NOW, 20);
      const first = Date.parse(weeks[0]!.week);
      const inWindow = trails.filter((t) => { const a = landedAt(t); return a !== null && a >= first; });
      expect(weeks.reduce((n, w) => n + w.landed, 0)).toBe(inWindow.length);
      for (const w of weeks) {
        if (!w.landed) expect(w.perLanded).toBeNull();
        else expect(w.perLanded!).toBeGreaterThanOrEqual(Math.floor(w.landedSpend / w.landed));
      }
    }));
  });

  test("a closed quest without a receipt is a dead end, never a landing", () => {
    const t: CostTrail = { id: "a", state: "closed", updatedAt: new Date(NOW).toISOString(),
      budget: { tokensUsed: 0, tokensMax: 0, spendMicrousdUsed: 3_000_000, spendMicrousdMax: 0 } };
    const w = weeklyCost([t], NOW, 1)[0]!;
    expect(w).toMatchObject({ landed: 0, deadEnds: 1, deadEndSpend: 3_000_000, perLanded: null });
  });

  test("no trend is claimed from too few weeks, and the sign of a claimed trend follows the data", () => {
    const series = (ys: (number | null)[]): WeekCost[] => ys.map((y, i) => ({
      week: String(i), landed: y === null ? 0 : 1, landedSpend: y ?? 0, deadEnds: 0, deadEndSpend: 0, perLanded: y,
    }));
    expect(costTrend(series([5, null, 4])).direction).toBe("unknown");
    expect(costTrend(series([9e6, 7e6, 5e6, 3e6])).direction).toBe("down");
    expect(costTrend(series([3e6, 5e6, 7e6])).direction).toBe("up");
    expect(costTrend(series([5e6, 5.05e6, 4.98e6])).direction).toBe("flat");
    fc.assert(fc.property(fc.array(fc.option(fc.integer({ min: 1, max: 1e8 }), { nil: null }), { maxLength: 16 }), (ys) => {
      const t = costTrend(series(ys));
      const n = ys.filter((y) => y !== null).length;
      expect(t.points).toBe(n);
      if (n < MIN_TREND_POINTS) expect(t.direction).toBe("unknown");
      if (t.change !== null) expect(t.change).toBeGreaterThanOrEqual(-1);
    }));
  });

  test("the pace outlook leaves out today, brackets the expectation, and needs a full week", () => {
    const day = (i: number, cost: number) => ({ key: new Date(NOW - i * DAY).toISOString().slice(0, 10),
      totals: { entries: 1, tokens: 0, costMicrousd: cost, wallMs: 0, unknownCost: 0, failed: 0, unavailable: 0 } });
    fc.assert(fc.property(fc.array(fc.nat(5_000_000), { minLength: 0, maxLength: 60 }), fc.integer({ min: 1, max: 180 }), (costs, h) => {
      const days = costs.map((c, i) => day(costs.length - i, c));
      const today = new Date(NOW).toISOString().slice(0, 10);
      const o = outlook([...days, day(0, 99_000_000)], today, h);
      if (costs.length < 7) { expect(o).toBeNull(); return; }
      expect(o!.historyDays).toBe(costs.length);
      expect(o!.low).toBeLessThanOrEqual(o!.high);
    }));
  });
});
