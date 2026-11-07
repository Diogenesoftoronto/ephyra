import { expect, test } from "bun:test";
import fc from "fast-check";
import { MemoryUsageStore, usageTotals } from "./usage.ts";
import type { UsageEntry } from "@ephyra/core";

function entry(key: string, cost: number | null): UsageEntry {
  return { id: key, idempotencyKey: key, at: "2026-11-07T00:00:00.000Z", kind: "draft", persona: "velum",
    step: "draft", engine: "fake", trailId: null, short: null, tokens: null, costMicrousd: cost,
    wallMs: null, outcome: "ok", billedTo: "unknown" };
}
test("memory store deduplicates by operation key", async () => {
  const store = new MemoryUsageStore();
  await store.record(entry("one", null));
  await store.record(entry("one", 5));
  expect(await store.list()).toEqual([entry("one", null)]);
});
test("totals retain unknown costs across partitions", () => {
  fc.assert(fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null })), (costs) => {
    const rows = costs.map((cost, i) => entry(String(i), cost));
    const total = usageTotals(rows);
    const groups = [usageTotals(rows.filter((_, i) => i % 2 === 0)), usageTotals(rows.filter((_, i) => i % 2 === 1))];
    expect(total.costMicrousd).toBe(groups[0]!.costMicrousd + groups[1]!.costMicrousd);
    expect(total.unknownCost).toBe(costs.filter((cost) => cost === null).length);
    expect(total.unknownCost).toBe(groups[0]!.unknownCost + groups[1]!.unknownCost);
  }));
});
