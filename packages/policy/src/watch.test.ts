import { expect, test } from "bun:test";
import type { WatchConfig, WatchObservations, Risk } from "@ephyra/core";
import { evaluateWatch } from "./index";
const config: WatchConfig = {
  windowS: 600,
  fingerprints: [],
  touchedFiles: [],
  routes: [],
  areaProbes: [],
  baseline: { errorRate: 1 },
  startedAt: "2026-01-01T00:00:00Z",
};
const clean: WatchObservations = {
  elapsedS: 600,
  fingerprintRecurrences: 0,
  newFingerprintsInTouchedFiles: [],
  probeConsecutiveFailures: {},
  errorRate: { current: 1, baseline: 1, sustainedAboveS: 0 },
  tracerNewClusters: 0,
  coverageGaps: [],
};
for (const risk of ["low", "medium", "high", "critical"] as Risk[])
  test(`recurrence boundary ${risk}`, () => {
    const limit = risk === "low" || risk === "medium" ? 3 : 1;
    expect(
      evaluateWatch(
        config,
        { ...clean, fingerprintRecurrences: limit - 1 },
        risk,
      ).rollback,
    ).toBe(false);
    expect(
      evaluateWatch(config, { ...clean, fingerprintRecurrences: limit }, risk)
        .rollback,
    ).toBe(true);
  });
test("new fingerprints and consecutive probe failures", () => {
  expect(
    evaluateWatch(
      config,
      { ...clean, newFingerprintsInTouchedFiles: ["new"] },
      "low",
    ).rollback,
  ).toBe(true);
  expect(
    evaluateWatch(
      config,
      { ...clean, probeConsecutiveFailures: { probe: 1 } },
      "low",
    ).rollback,
  ).toBe(false);
  expect(
    evaluateWatch(
      config,
      { ...clean, probeConsecutiveFailures: { probe: 2 } },
      "low",
    ).rollback,
  ).toBe(true);
});
test("error rate strict threshold and sustained duration", () => {
  for (const [current, duration, rollback] of [
    [1.5, 600, false],
    [1.501, 599, false],
    [1.501, 600, true],
  ] as const) {
    expect(
      evaluateWatch(
        config,
        {
          ...clean,
          errorRate: { current, baseline: 1, sustainedAboveS: duration },
        },
        "low",
      ).rollback,
    ).toBe(rollback);
  }
});
test("closure requires complete window and coverage; clusters are advisory", () => {
  expect(
    evaluateWatch(config, { ...clean, elapsedS: 599 }, "low"),
  ).toMatchObject({ rollback: false, canClose: false });
  expect(evaluateWatch(config, clean, "low")).toMatchObject({
    rollback: false,
    canClose: true,
  });
  expect(
    evaluateWatch(config, { ...clean, coverageGaps: ["probe"] }, "low"),
  ).toMatchObject({ rollback: false, canClose: false });
  // With routes to watch, a missing error rate blocks closure; with none, the criterion does not apply.
  expect(
    evaluateWatch({ ...config, routes: ["/cart"] }, { ...clean, errorRate: null }, "low"),
  ).toMatchObject({ rollback: false, canClose: false });
  expect(
    evaluateWatch(config, { ...clean, errorRate: null }, "low"),
  ).toMatchObject({ rollback: false, canClose: true });
  expect(
    evaluateWatch(config, { ...clean, tracerNewClusters: 1 }, "low"),
  ).toMatchObject({
    rollback: false,
    canClose: true,
    advisories: ["new tracer clusters"],
  });
});
