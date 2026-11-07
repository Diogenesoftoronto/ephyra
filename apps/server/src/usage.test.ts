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

// ── aggregation ──
import { PERSONAS, type PersonaId } from "@ephyra/core";
import { BadCursor, DAY_MS, UsageRecorder, addTotals, pageEntries, safeNote, summarizeUsage, utcDays, type TrailInfo } from "./usage.ts";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const rowArb = fc.record({
  n: fc.integer({ min: 0, max: 9 * DAY_MS }),
  cost: fc.option(fc.integer({ min: 0, max: 5_000_000 }), { nil: null }),
  tokens: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
  wall: fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: null }),
  persona: fc.option(fc.constantFrom(...PERSONAS.map((p) => p.id)), { nil: null }),
  engine: fc.constantFrom("claude-code/claude-opus-5-5", "judgement-jev/jev-1.14", "fake"),
  outcome: fc.constantFrom("ok" as const, "failed" as const, "unavailable" as const),
  trail: fc.option(fc.constantFrom("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"), { nil: null }),
});
const rows = fc.array(rowArb, { maxLength: 60 }).map((rs): UsageEntry[] => rs.map((r, i) => ({
  ...entry(`k${i}`, r.cost), at: new Date(T0 + r.n).toISOString(), persona: r.persona as PersonaId | null, engine: r.engine,
  tokens: r.tokens, wallMs: r.wall, outcome: r.outcome, trailId: r.trail, short: r.trail ? r.trail.slice(0, 2) : null,
})));
const window = { from: new Date(T0), to: new Date(T0 + 7 * DAY_MS) };
const sum = (gs: { totals: ReturnType<typeof usageTotals> }[]) => gs.reduce((t, g) => addTotals(t, g.totals), usageTotals([]));

test("summary: totals equal the sum of every full partition; unknown costs are counted, never summed as zero", () => {
  fc.assert(fc.property(rows, (all) => {
    const s = summarizeUsage(all, window, new Map());
    const inWindow = all.filter((e) => Date.parse(e.at) <= window.to.getTime());
    expect(s.totals.entries).toBe(inWindow.length);
    expect(sum(s.byPersona)).toEqual(s.totals);
    expect(sum(s.byEngine)).toEqual(s.totals);
    expect(sum(s.byDay)).toEqual(s.totals);
    expect(s.totals.unknownCost).toBe(inWindow.filter((e) => e.costMicrousd === null).length);
    expect(s.totals.costMicrousd).toBe(inWindow.reduce((t, e) => t + (e.costMicrousd ?? 0), 0));
    // by-trail only holds trail-attributed rows, and its unknown costs add up to those rows' unknown costs.
    expect(sum(s.byTrail).entries).toBe(inWindow.filter((e) => e.trailId).length);
    expect(sum(s.byTrail).unknownCost).toBe(inWindow.filter((e) => e.trailId && e.costMicrousd === null).length);
  }));
});
test("summary: every day in the window is present, oldest first, including empty days", () => {
  const s = summarizeUsage([entryAt("a", 2 * DAY_MS + 5)], window, new Map());
  expect(s.byDay.map((d) => d.key)).toEqual(utcDays(window.from, window.to));
  expect(s.byDay).toHaveLength(8);
  expect(s.byDay.map((d) => d.totals.entries)).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
});
test("summary: filters by persona, engine and trail; an all-unknown group stays unknown rather than zero", () => {
  const a = { ...entryAt("a", 10), persona: "bell" as const, engine: "x", costMicrousd: null, trailId: "11111111-1111-4111-8111-111111111111", short: "ab" };
  const b = { ...entryAt("b", 20), persona: null, engine: "y", costMicrousd: 7 };
  const infos = new Map<string, TrailInfo>([[a.trailId, { id: a.trailId, short: "ab", title: "T", budget: { spendMicrousdUsed: 1, spendMicrousdMax: 2, tokensUsed: 3, tokensMax: 4 } }]]);
  expect(summarizeUsage([a, b], { ...window, persona: "bell" }, infos).totals).toMatchObject({ entries: 1, costMicrousd: 0, unknownCost: 1 });
  expect(summarizeUsage([a, b], { ...window, persona: "unattributed" }, infos).totals).toMatchObject({ entries: 1, costMicrousd: 7, unknownCost: 0 });
  expect(summarizeUsage([a, b], { ...window, engine: "y" }, infos).byEngine.map((g) => g.key)).toEqual(["y"]);
  const byTrail = summarizeUsage([a, b], { ...window, trail: "ab" }, infos).byTrail;
  expect(byTrail).toHaveLength(1);
  expect(byTrail[0]).toMatchObject({ short: "ab", title: "T", budget: { spendMicrousdMax: 2 } });
});
test("pagination: pages cover every entry once, newest first, with stable cursors", () => {
  fc.assert(fc.property(rows, fc.integer({ min: 1, max: 9 }), (all, limit) => {
    const f = { from: new Date(T0), to: new Date(T0 + 10 * DAY_MS) };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const page = pageEntries(all, f, { limit, ...(cursor ? { cursor } : {}) });
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.cursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(all.length);
    expect(seen).toHaveLength(all.length);
    const ats = seen.map((id) => all.find((e) => e.id === id)!.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  }));
  expect(() => pageEntries([], window, { limit: 1, cursor: "!!" })).toThrow(BadCursor);
});
test("recorder: model hook is idempotent, maps the purpose to a persona, and a failing store never throws", async () => {
  const store = new MemoryUsageStore();
  const recorder = new UsageRecorder(store, () => undefined, () => new Date("2026-11-07T10:00:00Z"));
  const hook = recorder.modelHook("notorganic");
  const call = { alias: "j", identity: "judgement-jev/jev-1.14", purpose: "decide.triage" as const, idempotencyKey: "triage:1", tokens: 12, costMicrousd: null };
  await hook(call);
  await hook(call);
  await hook({ ...call, purpose: "extract", idempotencyKey: "x", identity: "clairic/1" });
  const rowsOut = await store.list();
  expect(rowsOut).toHaveLength(2);
  expect(rowsOut.find((r) => r.step === "triage")).toMatchObject({ kind: "triage", persona: "rho", costMicrousd: null, billedTo: "notorganic", outcome: "ok" });
  expect(rowsOut.find((r) => r.kind === "extract")).toMatchObject({ persona: "rho", engine: "clairic/1" });
  const logs: unknown[] = [];
  const broken = new UsageRecorder({ record: async () => { throw new Error("convex down"); }, list: async () => [] }, (m) => logs.push(m));
  await broken.record({ ...entry("z", null), at: undefined } as never);
  expect(logs).toEqual(["usage record failed"]);
});
test("safeNote strips credentials and bounds length", () => {
  const dirty = "failed: Authorization: Bearer abcdef123456 and EPHYRA_API_KEY=sk-live-abcdefghijkl token=\"zzzzzzzz\" " + "x".repeat(400);
  const note = safeNote(dirty);
  expect(note).not.toMatch(/abcdef123456|sk-live|zzzzzzzz/);
  expect(note.length).toBeLessThanOrEqual(300);
  expect(safeNote("clone failed for ephyra/app")).toBe("clone failed for ephyra/app");
});
function entryAt(key: string, offsetMs: number): UsageEntry { return { ...entry(key, 1), at: new Date(T0 + offsetMs).toISOString() }; }
