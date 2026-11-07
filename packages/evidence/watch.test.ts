import { expect, test } from "bun:test";
import { WatchCollector } from "./src/index.ts";
import type { SignalStore, WatchConfig } from "@ephyra/core";

test("watch preserves consecutive failures across calls and reports gaps", async () => {
  const config: WatchConfig = { windowS: 3600, fingerprints: ["fingerprint"], touchedFiles: ["a"], routes: ["/"], areaProbes: ["p"], baseline: { errorRate: 0.1 }, startedAt: "2026-01-01T00:00:00Z" };
  const signals = { countSince: async () => 2, newFingerprintsInFiles: async () => [], errorRate: async () => ({ errors: 3, requests: 10 }) } as unknown as SignalStore;
  const collector = new WatchCollector();
  const clock = { now: () => new Date("2026-01-01T00:01:00Z") };
  const a = await collector.collect(config, { signals, clock, runProbe: async () => "fail" });
  const b = await collector.collect(config, { signals, clock, state: a.state, runProbe: async () => "fail" });
  const c = await collector.collect(config, { signals, clock, state: b.state, runProbe: async () => "unavailable" });
  expect(c.observations.probeConsecutiveFailures.p).toBe(2);
  expect(c.observations.fingerprintRecurrences).toBe(2);
  expect(c.observations.coverageGaps).toContain("probe:p");
});

test("watch uses timestamps, resets on recovery and breaks duration at telemetry gaps", async () => {
  const config: WatchConfig = { windowS: 3600, fingerprints: ["fp"], touchedFiles: ["a"], routes: ["/"],
    areaProbes: ["p"], baseline: { errorRate: 0.1 }, startedAt: "2026-01-01T00:00:00Z" };
  let timestamp = Date.parse(config.startedAt);
  let rate: { errors: number; requests: number } | null = { errors: 3, requests: 10 };
  let probe: "pass" | "fail" | "unavailable" = "fail";
  const signals = { countSince: async () => 1, newFingerprintsInFiles: async () => [{ fingerprint: "new" }],
    errorRate: async () => rate } as unknown as SignalStore;
  const collector = new WatchCollector();
  const clock = { now: () => new Date(timestamp) };
  let result = await collector.collect(config, { signals, clock, runProbe: async () => probe });
  timestamp += 12500;
  result = await collector.collect(config, { signals, clock, state: result.state, runProbe: async () => probe });
  expect(result.observations.errorRate?.sustainedAboveS).toBe(12.5);
  expect(result.observations.probeConsecutiveFailures.p).toBe(2);
  expect(result.observations.newFingerprintsInTouchedFiles).toEqual(["new"]);
  rate = null;
  probe = "unavailable";
  timestamp += 1000;
  result = await collector.collect(config, { signals, clock, state: result.state, runProbe: async () => probe });
  expect(result.observations.coverageGaps).toContain("error rate:/");
  expect(result.observations.coverageGaps).toContain("probe:p");
  expect(result.observations.errorRate).toBeNull();
  expect(result.state.aboveSince).toBeNull();
  rate = { errors: 3, requests: 10 };
  probe = "pass";
  timestamp += 2000;
  result = await collector.collect(config, { signals, clock, state: result.state, runProbe: async () => probe });
  expect(result.observations.errorRate?.sustainedAboveS).toBe(0);
  expect(result.observations.probeConsecutiveFailures.p).toBe(0);
  rate = { errors: 1, requests: 10 };
  timestamp += 1000;
  result = await collector.collect(config, { signals, clock, state: result.state, runProbe: async () => probe });
  expect(result.state.aboveSince).toBeNull();
});

test("probe failure state matches sequences with gaps and resets", async () => {
  const fc = await import("fast-check");
  const config: WatchConfig = { windowS: 1, fingerprints: [], touchedFiles: [], routes: [], areaProbes: ["p"],
    baseline: { errorRate: 0 }, startedAt: "2026-01-01T00:00:00Z" };
  const signals = { newFingerprintsInFiles: async () => [] } as unknown as SignalStore;
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("pass", "fail", "unavailable"), { maxLength: 40 }), async sequence => {
    const collector = new WatchCollector();
    let state: import("./src/index.ts").WatchState | undefined;
    let expected = 0;
    for (const probe of sequence) {
      const result = await collector.collect(config, { signals, state, clock: { now: () => new Date(config.startedAt) },
        runProbe: async () => probe });
      if (probe === "fail") expected++;
      if (probe === "pass") expected = 0;
      expect(result.state.probeFailures.p ?? 0).toBe(expected);
      expect(result.observations.coverageGaps.includes("probe:p")).toBe(probe === "unavailable");
      state = result.state;
    }
  }));
});
