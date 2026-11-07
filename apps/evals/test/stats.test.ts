import { test, expect } from "bun:test";
import fc from "fast-check";
import { accuracy, brier, ece, reliability, confusion, bootstrap } from "../src/stats";
import { corpusHash, loadCorpus, parseCorpus, canonical, SUITES } from "../src/data";
import { summarize, CaseResult } from "../src/results";
const ps = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 80 });
test("Brier is bounded, perfect at truth, and improves moving every prediction toward truth", () => {
  fc.assert(
    fc.property(ps, fc.boolean(), fc.double({ min: 0, max: 1, noNaN: true }), (p, y, a) => {
      const truth = p.map(() => y),
        moved = p.map((x) => x * (1 - a) + Number(y) * a);
      expect(brier(p, truth)!).toBeGreaterThanOrEqual(0);
      expect(brier(p, truth)!).toBeLessThanOrEqual(1);
      expect(brier(moved, truth)!).toBeLessThanOrEqual(brier(p, truth)! + 1e-12);
      expect(
        brier(
          p.map(() => Number(y)),
          truth,
        ),
      ).toBe(0);
    }),
  );
});
test("ECE bound and monotonic improvement for homogeneous truth; reliability accounts for every case including p=1", () => {
  fc.assert(
    fc.property(ps, fc.boolean(), (p, y) => {
      const truth = p.map(() => y),
        e = ece(p, truth)!;
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1 + 1e-12);
      expect(
        ece(
          p.map((x) => (x + Number(y)) / 2),
          truth,
        )!,
      ).toBeLessThanOrEqual(e + 1e-12);
      expect(reliability(p, truth).reduce((n, b) => n + b.n, 0)).toBe(p.length);
    }),
  );
  expect(reliability([1], [true]).at(-1)?.n).toBe(1);
});
test("Accuracy is confusion diagonal / total; relabeling preserves it", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })), { minLength: 1 }),
      (rows) => {
        const a = rows.map((r) => String(r[0])),
          b = rows.map((r) => String(r[1])),
          m = confusion(a, b);
        expect(
          Object.values(m)
            .flatMap(Object.values)
            .reduce((x, y) => x + y, 0),
        ).toBe(rows.length);
        expect(Object.entries(m).reduce((n, [k, v]) => n + (v[k] ?? 0), 0) / rows.length).toBe(
          accuracy(a, b)!,
        );
        expect(
          accuracy(
            a.map((x) => "L" + x),
            b.map((x) => "L" + x),
          ),
        ).toBe(accuracy(a, b)!);
      },
    ),
  );
});
test("Bootstrap contains observed point, stays within sample range and is reproducible", () => {
  fc.assert(
    fc.property(ps, (x) => {
      const ci = bootstrap(x, 100);
      expect(ci.low!).toBeLessThanOrEqual(ci.point!);
      expect(ci.high!).toBeGreaterThanOrEqual(ci.point!);
      expect(ci.low!).toBeGreaterThanOrEqual(Math.min(...x) - 1e-12);
      expect(ci.high!).toBeLessThanOrEqual(Math.max(...x) + 1e-12);
      expect(bootstrap(x, 100)).toEqual(ci);
    }),
  );
});
test("Hash ignores object key order and row order but changes with content", async () => {
  const rows = await loadCorpus("triage");
  fc.assert(
    fc.property(fc.shuffledSubarray(rows, { minLength: 1 }), (subset) => {
      expect(corpusHash(subset)).toBe(corpusHash([...subset].reverse().map((r) => JSON.parse(canonical(r)))));
      expect(corpusHash(subset)).not.toBe(
        corpusHash(subset.map((r) => ({ ...r, provenance: r.provenance + " changed" }))),
      );
    }),
  );
});
test("Corpora are versioned, unique, strict at triage labels and cannot mix suites", async () => {
  for (const suite of SUITES) {
    const rows = await loadCorpus(suite);
    expect(rows.length).toBeGreaterThan(0);
    expect(() => parseCorpus(JSON.stringify(rows[0]) + "\n" + JSON.stringify(rows[0]), suite)).toThrow();
  }
  const rows = await loadCorpus("triage");
  expect(rows.length).toBeGreaterThanOrEqual(60);
  expect(rows.length).toBeLessThanOrEqual(100);
  expect(() => parseCorpus(JSON.stringify({ ...rows[0], expected: {} }), "triage")).toThrow();
  expect(() => parseCorpus("", "triage")).toThrow();
  expect(() => parseCorpus("{}", "proof")).toThrow();
});
test("Empty observations are null, malformed probabilities throw, unavailable never joins denominator", () => {
  expect(brier([], [])).toBeNull();
  expect(ece([], [])).toBeNull();
  expect(accuracy([], [])).toBeNull();
  expect(bootstrap([]).point).toBeNull();
  expect(() => brier([NaN], [true])).toThrow();
  expect(() => ece([1.1], [true])).toThrow();
  expect(() => accuracy(["a"], [])).toThrow();
  const base = {
    case_id: "x",
    identity: "one",
    status: "unavailable",
    scores: { x: { score: null, label: "unverified", explanation: "auth" } },
    output: null,
    wallMs: 0,
    tokens: null,
    costMicrousd: null,
    traceId: "x",
  };
  const r = CaseResult.parse(base);
  expect(summarize([r]).one!.metrics.x!.n).toBe(0);
  expect(() => CaseResult.parse({ ...base, tokens: -1 })).toThrow();
  expect(() =>
    CaseResult.parse({
      ...base,
      scores: { x: { score: 0, label: "fail", explanation: "unavailable is not zero" } },
    }),
  ).toThrow();
});
