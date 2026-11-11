import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  addReference, ExtractionForecastAnswer, forecastPoints, personLabel, referenceKey, referenceSource,
  VELUM_MAX_REFERENCES, VelumReference, VoiceReplyInput, UsageForecastInput, type VelumReference as Ref,
} from "../src/index.ts";

const uuid = "3a77e1aa-5b1e-4c3a-9d2f-000000000003";
const area = fc.record({ kind: fc.constant("area" as const), name: fc.constantFrom("payments", "cart", "site"), revision: fc.constantFrom("r1", "r2") });
const trail = fc.record({ kind: fc.constant("trail" as const), id: fc.constant(uuid), rev: fc.integer({ min: 1, max: 4 }) });
const usage = fc.record({ kind: fc.constant("usage" as const), facet: fc.constantFrom("spend", "drivers", "forecast") as fc.Arbitrary<"spend" | "drivers" | "forecast">, from: fc.constant("2026-11-01"), to: fc.constantFrom("2026-11-07", "2026-11-10") });
const ref: fc.Arbitrary<Ref> = fc.oneof(area, trail, usage);

describe("Velum references", () => {
  test("forecast and usage dates name real calendar days", () => {
    for (const asOf of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01"])
      expect(UsageForecastInput.safeParse({ asOf, historyDays: 28, horizonDays: 7 }).success).toBe(false);
    expect(UsageForecastInput.safeParse({ asOf: "2024-02-29", historyDays: 28, horizonDays: 7 }).success).toBe(true);
  });
  test("adding keeps one entry per source, bounded, newest revision wins", () => {
    fc.assert(fc.property(fc.array(ref, { maxLength: 30 }), (refs) => {
      let list: { ref: Ref }[] = [];
      for (const r of refs) list = addReference(list, { ref: r }).list;
      const sources = list.map((x) => referenceSource(x.ref));
      expect(new Set(sources).size).toBe(sources.length);
      expect(list.length).toBeLessThanOrEqual(VELUM_MAX_REFERENCES);
      for (const x of list) expect(VelumReference.safeParse(x.ref).success).toBe(true);
    }));
  });
  test("a newer revision replaces the older chip of the same source", () => {
    const a = addReference([], { ref: { kind: "trail", id: uuid, rev: 1 } }).list;
    const b = addReference(a, { ref: { kind: "trail", id: uuid, rev: 2 } }).list;
    expect(b.map((x) => referenceKey(x.ref))).toEqual([`trail:${uuid}@2`]);
  });
  test("a changed run status is a newer reference to the same source", () => {
    const running: Ref = { kind: "run", id: "run-1", status: "running" };
    const complete: Ref = { ...running, status: "complete" };
    expect(referenceSource(running)).toBe(referenceSource(complete));
    expect(referenceKey(running)).not.toBe(referenceKey(complete));
    expect(addReference([{ ref: running }], { ref: complete }).list).toEqual([{ ref: complete }]);
  });
  test("a full list reports the dropped reference instead of silently evicting", () => {
    let list: { ref: Ref }[] = [];
    for (const name of ["a", "b", "c", "d", "e", "f"]) list = addReference(list, { ref: { kind: "area", name, revision: "r" } }).list;
    const next = addReference(list, { ref: { kind: "area", name: "g", revision: "r" } });
    expect(next.dropped).toBe(true);
    expect(next.list).toHaveLength(VELUM_MAX_REFERENCES);
  });
  test("reply input refuses unbounded or malformed references", () => {
    const base = { context: { kind: "overview" }, messages: [{ role: "user", text: "hi" }] };
    expect(VoiceReplyInput.safeParse({ ...base, references: [{ kind: "trail", id: "not-a-uuid", rev: 1 }] }).success).toBe(false);
    expect(VoiceReplyInput.safeParse({ ...base, references: Array(7).fill({ kind: "run", id: "r" }) }).success).toBe(false);
    expect(VoiceReplyInput.safeParse(base).success).toBe(true);
  });
  test("labels never fall back to a DID", () => {
    fc.assert(fc.property(fc.option(fc.string()), fc.option(fc.string()), (displayName, handle) => {
      expect(personLabel({ displayName, handle })).not.toMatch(/^did:/);
    }));
    expect(personLabel({ displayName: null, handle: "dio.pds.notorganic.info" })).toBe("@dio.pds.notorganic.info");
    expect(personLabel(null)).toBe("Unverified account");
  });
});

describe("forecastPoints", () => {
  test("accepts both published answer forms", () => {
    const steps = ExtractionForecastAnswer.parse({ type: "forecast", value: [5, 5], steps: [{ type: "estimate", value: 5, median: 5, p10: 2, p90: 8 }, { type: "estimate", value: 5, median: 5, p10: 2, p90: 8 }] });
    expect(forecastPoints(steps, 2)).toEqual([{ median: 5, p10: 2, p90: 8 }, { median: 5, p10: 2, p90: 8 }]);
    const arrays = ExtractionForecastAnswer.parse({ type: "forecast", value: [5, 6], median: [5, 6], p10: [2, 3], p90: [8, 9] });
    expect(forecastPoints(arrays, 2)?.[1]).toEqual({ median: 6, p10: 3, p90: 9 });
  });
  test("rejects the contract's invalid cases", () => {
    const parse = (a: unknown) => forecastPoints(ExtractionForecastAnswer.parse(a), 2);
    expect(parse({ type: "forecast", value: [5, 5], steps: [{ median: 5, p10: 2, p90: 8 }] })).toBeNull();
    expect(parse({ type: "forecast", value: [5, 5], steps: [{ median: 5, p10: 2, p90: 8 }, { median: 5, p10: 2, p90: 1 }] })).toBeNull();
    expect(parse({ type: "forecast", value: [5, 6], median: [5, 6], p10: [2], p90: [8, 9] })).toBeNull();
    expect(parse({ type: "forecast", value: null })).toBeNull();
  });
  test("every accepted point keeps p10 <= median <= p90", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.float({ noNaN: true }), fc.float({ noNaN: true }), fc.float({ noNaN: true })), { minLength: 1, maxLength: 8 }), (rows) => {
      const answer = { type: "forecast" as const, value: rows.map((r) => r[0]), median: rows.map((r) => r[0]), p10: rows.map((r) => r[1]), p90: rows.map((r) => r[2]) };
      const out = forecastPoints(answer, rows.length);
      if (out) for (const p of out) expect(p.p10! <= p.median && p.median <= p.p90!).toBe(true);
    }));
  });
});
