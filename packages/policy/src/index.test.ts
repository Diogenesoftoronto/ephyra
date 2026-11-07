import { describe, expect, test } from "bun:test";
import { evaluateProof, evaluateWatch, requiredProof } from "./index.ts";
import type { WatchConfig, WatchObservations, Risk } from "@ephyra/core";

describe("proof", () => {
  for (const risk of ["low", "medium", "high", "critical"] as Risk[]) for (const ui of [false, true]) for (const userFacing of [false, true]) test(`${risk} ui=${ui} user=${userFacing} requires evidence`, () => {
    const flags = { ui, userFacing };
    expect(evaluateProof([], risk, flags).passed).toBe(false);
    expect(requiredProof(risk, flags).includes("story_render")).toBe(ui);
  });
});
const config: WatchConfig = { windowS: 60, fingerprints: [], touchedFiles: [], routes: [], areaProbes: [], baseline: { errorRate: 1 }, startedAt: "2026-01-01T00:00:00Z" };
const obs: WatchObservations = { elapsedS: 60, fingerprintRecurrences: 0, newFingerprintsInTouchedFiles: [], probeConsecutiveFailures: {}, errorRate: { current: 1, baseline: 1, sustainedAboveS: 0 }, tracerNewClusters: 0, coverageGaps: [] };
test("watch boundaries and coverage", () => {
  expect(evaluateWatch(config, { ...obs, fingerprintRecurrences: 2 }, "low").rollback).toBe(false);
  expect(evaluateWatch(config, { ...obs, fingerprintRecurrences: 3 }, "low").rollback).toBe(true);
  expect(evaluateWatch(config, { ...obs, fingerprintRecurrences: 1 }, "high").rollback).toBe(true);
  expect(evaluateWatch(config, { ...obs, errorRate: { current: 1.5, baseline: 1, sustainedAboveS: 600 } }, "low").rollback).toBe(false);
  expect(evaluateWatch(config, { ...obs, errorRate: { current: 1.6, baseline: 1, sustainedAboveS: 600 } }, "low").rollback).toBe(true);
  expect(evaluateWatch(config, { ...obs, coverageGaps: ["missing"] }, "low")).toMatchObject({ canClose: false });
});
import fc from "fast-check";
import { applyTriage, areaFor, parseAutonomy, parseThresholds, THRESHOLDS_TEMPLATE } from "./index.ts";
import type { ExtractionResponse, JudgementResponse } from "@ephyra/core";
test("autonomy example and malformed risk", () => {
  const p = parseAutonomy("## defaults\nmode: enforce\n## area: broad\npaths: src/**\nrisk: low\n## area: narrow\npaths: src/cart/**\nrisk: medium\nKeep this prose.\n");
  expect(areaFor(p, ["src/cart/a.ts"]).name).toBe("narrow");
  expect(p.areas[1]!.prose).toBe("Keep this prose.\n");
  expect(() => parseAutonomy("## area: a\nrisk: bad\n")).toThrow("line 2");
});
test("specific glob wins for arbitrary filenames", () => fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,12}$/), name => {
  const p = parseAutonomy("## area: broad\npaths: src/**\n## area: narrow\npaths: src/cart/**\n");
  expect(areaFor(p, [`src/cart/${name}`]).name).toBe("narrow");
})));
test("low confidence and unknown identities never auto fix", () => fc.assert(fc.property(fc.double({ min: 0, max: 0.499, noNaN: true }), confidence => {
  const area = parseAutonomy("## area: a\npaths: src/**\n").areas[0]!;
  const response: JudgementResponse = { model: "judgement-jev/jev-1.14", answers: { route: { type: "choice", choice: "auto_fix", confidence, probabilities: { auto_fix: confidence } }, duplicate_of: { type: "choice", choice: "none", confidence: 1, probabilities: { none: 1 } } } };
  const extraction: ExtractionResponse = { model: "extract", answers: {} };
  expect(applyTriage(response, extraction, parseThresholds(THRESHOLDS_TEMPLATE), area).route).toBe("research_only");
  expect(applyTriage({ ...response, model: "unknown" }, extraction, {}, area).route).toBe("research_only");
})));
