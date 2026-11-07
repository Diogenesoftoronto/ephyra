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
