import type { Clock, SignalStore, WatchConfig, WatchObservations } from "@ephyra/core";

export type WatchState = { probeFailures: Record<string, number>; aboveSince: string | null };
export type WatchDeps = {
  signals: SignalStore;
  runProbe(id: string): Promise<"pass" | "fail" | "unavailable">;
  clock: Clock;
  state?: WatchState;
  errorRateMultiplier?: number;
};

/** Collect measurements; policy owns rollback decisions. Persist state between observations. */
export class WatchCollector {
  async collect(config: WatchConfig, deps: WatchDeps): Promise<{ observations: WatchObservations; state: WatchState }> {
    const now = deps.clock.now();
    const start = new Date(config.startedAt);
    const gaps: string[] = [];
    const state: WatchState = {
      probeFailures: { ...deps.state?.probeFailures },
      aboveSince: deps.state?.aboveSince ?? null,
    };
    let recurrences = 0;
    for (const fingerprint of new Set(config.fingerprints)) {
      try { recurrences += await deps.signals.countSince(fingerprint, start); }
      catch { gaps.push(`fingerprint:${fingerprint}`); }
    }
    let newFingerprints: string[] = [];
    try {
      const signals = await deps.signals.newFingerprintsInFiles(config.touchedFiles, start);
      newFingerprints = [...new Set(signals.map(signal => signal.fingerprint))];
    } catch { gaps.push("new fingerprints"); }
    for (const id of new Set(config.areaProbes)) {
      let result: "pass" | "fail" | "unavailable" = "unavailable";
      try { result = await deps.runProbe(id); } catch { /* reported as a gap */ }
      if (result === "unavailable") gaps.push(`probe:${id}`);
      else state.probeFailures[id] = result === "pass" ? 0 : (state.probeFailures[id] ?? 0) + 1;
    }
    const errorRate = await this.collectRate(config, deps, start, now, state, gaps);
    // Tracer clusters are advisory (design/01 §8.3); with no tracer source configured they are not a gap.
    return { observations: {
      elapsedS: Math.max(0, (now.getTime() - start.getTime()) / 1000),
      fingerprintRecurrences: recurrences,
      newFingerprintsInTouchedFiles: newFingerprints,
      probeConsecutiveFailures: { ...state.probeFailures },
      errorRate,
      tracerNewClusters: 0,
      coverageGaps: gaps,
    }, state };
  }

  private async collectRate(
    config: WatchConfig, deps: WatchDeps, start: Date, now: Date, state: WatchState, gaps: string[],
  ): Promise<WatchObservations["errorRate"]> {
    if (!config.routes.length) {
      // No routes are attributable to this trail, so the error-rate criterion does not apply.
      state.aboveSince = null;
      return null;
    }
    let errors = 0;
    let requests = 0;
    let complete = true;
    for (const route of new Set(config.routes)) {
      try {
        const rate = await deps.signals.errorRate(route, start, now);
        if (!rate || rate.requests <= 0) { complete = false; gaps.push(`error rate:${route}`); }
        else { errors += rate.errors; requests += rate.requests; }
      } catch { complete = false; gaps.push(`error rate:${route}`); }
    }
    if (!complete || !requests) { state.aboveSince = null; return null; }
    const current = errors / requests;
    if (current > config.baseline.errorRate * (deps.errorRateMultiplier ?? 2)) {
      if (!state.aboveSince || !Number.isFinite(Date.parse(state.aboveSince)) || Date.parse(state.aboveSince) > now.getTime()) {
        state.aboveSince = now.toISOString();
      }
    } else state.aboveSince = null;
    return { current, baseline: config.baseline.errorRate,
      sustainedAboveS: state.aboveSince ? (now.getTime() - Date.parse(state.aboveSince)) / 1000 : 0 };
  }
}
