import type { Risk, WatchConfig, WatchObservations } from "@ephyra/core";
export type WatchResult =
  | { rollback: true; criterion: string }
  | { rollback: false; advisories: string[]; canClose: boolean };
export function evaluateWatch(
  config: WatchConfig,
  obs: WatchObservations,
  risk: Risk,
): WatchResult {
  if (
    obs.fingerprintRecurrences >=
    (risk === "high" || risk === "critical" ? 1 : 3)
  )
    return { rollback: true, criterion: "original fingerprint recurred" };
  if (obs.newFingerprintsInTouchedFiles.length >= 1)
    return { rollback: true, criterion: "new fingerprint in touched files" };
  if (Object.values(obs.probeConsecutiveFailures).some((n) => n >= 2))
    return { rollback: true, criterion: "probe failed twice consecutively" };
  if (
    obs.errorRate &&
    obs.errorRate.current > obs.errorRate.baseline * 1.5 &&
    obs.errorRate.sustainedAboveS >= 600
  )
    return { rollback: true, criterion: "error rate exceeded baseline" };
  const advisories = obs.coverageGaps.map((gap) => `coverage gap: ${gap}`);
  if (obs.tracerNewClusters > 0) advisories.push("new tracer clusters");
  const rateApplies = config.routes.length > 0;
  if (rateApplies && obs.errorRate === null) advisories.push("error rate unavailable");
  return {
    rollback: false,
    advisories,
    canClose:
      obs.elapsedS >= config.windowS &&
      obs.coverageGaps.length === 0 &&
      (!rateApplies || obs.errorRate !== null),
  };
}
