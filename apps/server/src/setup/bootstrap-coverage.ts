import type { BootstrapCoverage } from "@ephyra/core";
import type { PostHogEvidence } from "@ephyra/evidence";
import type { PostHogPolling } from "./telemetry.ts";

/** A connected source and an observed query window are different facts. Neither proves all routes are instrumented. */
export async function telemetryCoverage(
  polling: PostHogPolling | null,
  resolve?: () => Promise<PostHogEvidence | null>,
): Promise<BootstrapCoverage> {
  const base = { id: "telemetry" as const, references: [] as string[] };
  let source: PostHogEvidence | null;
  try { source = await resolve?.() ?? null; }
  catch { return { ...base, status: "unknown", summary: "Telemetry access could not be checked. Reconnect the scoped source." }; }
  if (!source) return { ...base, status: "missing", summary: "Connect error telemetry so Ephyra can observe this repository." };
  const observation = await polling?.latest();
  if (!observation || observation.result.source !== source.name) return { ...base, status: "configured",
    references: [source.name], summary: "A telemetry source is configured. No recent authorized query window is recorded." };
  const { result, at } = observation;
  const coverage = result.coverage;
  const references = [source.name, ...(coverage?.windowSince && coverage.windowUntil
    ? [`window:${coverage.windowSince}/${coverage.windowUntil}`] : []),
  ...(coverage?.computedThrough ? [`computed-through:${coverage.computedThrough}`] : [])];
  if (result.status !== "complete" || !coverage?.complete || !coverage.computedThrough) return {
    ...base, status: "configured", checkedAt: at, references,
    summary: "The latest telemetry pass did not establish a complete fresh query window. Coverage remains unverified.",
  };
  return { ...base, status: "observed", checkedAt: at, references,
    summary: `Queried a complete error window and observed ${result.observed} exception event${result.observed === 1 ? "" : "s"}. `
      + "This does not establish instrumentation of every route or a healthy application." };
}
