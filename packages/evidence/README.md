# Evidence

GitEvidence searches pickaxe history and offers grep, recent commits and line blame. EntireEvidence wraps JSON search and only returns recorded checkpoint IDs; unavailable or unrecognized responses throw `Unverified`. WatchCollector collects signal counts, probe outcomes and route error rates. Persist its returned state between calls; policy evaluates the observations. Missing telemetry, probes and tracer cluster coverage are reported as gaps.

Tests use a temporary Git repository and fakes. Live Entire behavior, text fallback, tracer collection, OpenObserve, trails and voxq are unverified or not implemented. Watch error-rate duration records consecutive observations above the injected multiplier (default 2), not continuous telemetry between samples.

OpenObserve SQL search and journal trail ranking have initial implementations. Voxq REST methods enforce a spend gate; the upstream service does not document idempotent writes. Live behavior, proof mapping, route search, export format and adapter completeness remain unverified. OpenObserve API reference: https://openobserve.ai/docs/reference/api/search/search/
