import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { UsageEntry } from "@ephyra/core";
import { lineDiff, diffStats, withContext } from "./diff.ts";
import { formatMicrousd, formatTotalCost, formatDuration, safeHref, relativeTime, percent } from "./format.ts";
import { addEntry, emptyTotals, summarize, totalsOf } from "./usage.ts";
import { hasBlocking, splitWarnings } from "./warnings.ts";

const text = fc.array(fc.constantFrom("a", "b", "c", "", "d d", "e"), { maxLength: 14 }).map((l) => l.join("\n"));

describe("lineDiff", () => {
  test("same + del rebuilds the old text and same + add rebuilds the new text", () => {
    fc.assert(fc.property(text, text, (a, b) => {
      const ops = lineDiff(a, b);
      expect(ops.filter((o) => o.kind !== "add").map((o) => o.text).join("\n")).toBe(a);
      expect(ops.filter((o) => o.kind !== "del").map((o) => o.text).join("\n")).toBe(b);
    }));
  });
  test("identical text has no changes and context folds unchanged runs", () => {
    const same = "1\n2\n3\n4\n5\n6\n7\n8";
    expect(diffStats(lineDiff(same, same))).toEqual({ added: 0, removed: 0 });
    const rows = withContext(lineDiff(same, same.replace("5", "five")), 1);
    expect(rows.some((r) => "skipped" in r)).toBe(true);
    expect(rows.filter((r) => "kind" in r && r.kind === "add")).toHaveLength(1);
  });
  test("line numbers follow each side", () => {
    const ops = lineDiff("a\nb\nc", "a\nx\nc");
    expect(ops.find((o) => o.kind === "del")).toMatchObject({ text: "b", aLine: 2 });
    expect(ops.find((o) => o.kind === "add")).toMatchObject({ text: "x", bLine: 2 });
  });
});

describe("formatting", () => {
  test("unknown cost is never $0", () => {
    expect(formatMicrousd(null)).toBe("unknown");
    expect(formatMicrousd(0)).toBe("$0.00");
    expect(formatMicrousd(3_500)).toBe("<$0.01");
    expect(formatMicrousd(4_200_000)).toBe("$4.20");
    expect(formatTotalCost({ costMicrousd: 0, unknownCost: 3 })).toBe("unknown (3)");
    expect(formatTotalCost({ costMicrousd: 1_500_000, unknownCost: 2 })).toBe("$1.50 + 2 unknown");
    expect(formatTotalCost({ costMicrousd: 1_500_000, unknownCost: 0 })).toBe("$1.50");
  });
  test("durations, relative time, percent and links", () => {
    expect(formatDuration(7 * 60_000 + 12_000)).toBe("7m 12s");
    expect(formatDuration(null)).toBe("unknown");
    expect(relativeTime("2026-11-07T14:00:00Z", Date.parse("2026-11-07T15:00:00Z"))).toBe("1h ago");
    expect(percent(5, 0)).toBe(0);
    expect(percent(9, 6)).toBe(100);
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("https://forge.example/pr/1")).toBe("https://forge.example/pr/1");
  });
});

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  id: "u", idempotencyKey: "k", at: "2026-11-07T10:00:00Z", kind: "agent_step", persona: "bell", step: "research", engine: "e", trailId: null,
  short: null, tokens: 10, costMicrousd: 100, wallMs: 5, outcome: "ok", billedTo: "byok", ...over,
});

describe("usage arithmetic", () => {
  test("unknown costs are counted and never added as zero", () => {
    fc.assert(fc.property(fc.array(fc.option(fc.nat(10_000), { nil: null }), { maxLength: 30 }), (costs) => {
      const rows = costs.map((c) => entry({ costMicrousd: c }));
      const t = totalsOf(rows);
      expect(t.unknownCost).toBe(costs.filter((c) => c === null).length);
      expect(t.costMicrousd).toBe(costs.reduce<number>((s, c) => s + (c ?? 0), 0));
      expect(t.entries).toBe(rows.length);
    }));
  });
  test("failed and unavailable rows are counted separately", () => {
    const t = [entry({ outcome: "failed" }), entry({ outcome: "unavailable", costMicrousd: null }), entry({})].reduce(addEntry, emptyTotals());
    expect([t.failed, t.unavailable, t.unknownCost]).toEqual([1, 1, 1]);
  });
  test("summaries have one bucket per day, including empty days, and group totals add up", () => {
    const rows = [entry({ at: "2026-11-05T10:00:00Z" }), entry({ at: "2026-11-07T10:00:00Z", persona: null, step: "mystery" })];
    const s = summarize(rows, "2026-11-05T00:00:00Z", "2026-11-07T12:00:00Z", []);
    expect(s.byDay.map((d) => d.key)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
    expect(s.byDay[1]!.totals.entries).toBe(0);
    expect(s.byPersona.find((g) => g.key === null)?.totals.entries).toBe(1);
    expect(s.byPersona.reduce((n, g) => n + g.totals.entries, 0)).toBe(s.totals.entries);
  });
});

describe("warnings", () => {
  test("parser errors block; unknown keys do not", () => {
    expect(hasBlocking(["line 4: unknown key faceted"])).toBe(false);
    expect(hasBlocking(["line 7: invalid risk"])).toBe(true);
    expect(splitWarnings(["line 7: invalid risk", "line 4: unknown key x"])).toEqual({ errors: ["line 7: invalid risk"], notes: ["line 4: unknown key x"] });
  });
});
