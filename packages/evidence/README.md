# Evidence

`GitEvidence` searches pickaxe history and exposes grep, recent commits and blame. `EntireEvidence` searches JSON, falls back to text when an older CLI rejects JSON flags, and returns only recorded checkpoint IDs. Missing or disabled Entire is `Unavailable`; unrecognized output is `Unverified`.

`OpenObserveEvidence` searches configured fields for a fingerprint, trace ID or route. It uses the [OpenObserve search API](https://openobserve.ai/docs/reference/api/search/search/), with an injected Authorization header and microsecond time bounds. Configure the stream and field names to match the telemetry deployment. Partial or failed responses are not empty success. `TrailsEvidence` ranks journal records by shared files and fingerprints, then recency; its injected resolver provides those associations.

`VoxqClient` uses the Rust service's survey, estimate, simulation, publication, results and export endpoints. Publication requires a non-shadow approval; policy approval also requires an explicit budget. `personaProof` requires a completed selected simulation with recorded responses. `respondentProof` counts distinct completed human interview labels in an export and requires the caller to supply the recorded collection ID, channel, spend and outcome. Human interviews in the export are current, not frozen to the selected simulation; collection ID and spend are not verified by the export. They must be independently recorded. An unknown spend must not be represented as zero. Synthetic results never become human proof.

The Voxq service does not establish idempotency from the operation key header. Persist operation keys and reconcile ambiguous writes externally; never retry them blindly. The adapters and proof mapping are verified with fixtures, not live services. Entire text parsing is limited to full checkpoint IDs in text rows; unknown formats fail closed. Live Entire, OpenObserve and Voxq behavior remains unverified.

`WatchCollector` returns observations and state for callers to persist; policy decides rollback. Error-rate duration uses elapsed timestamps between observed above-threshold samples, not a guarantee of continuous telemetry. Gaps reset this interval, unavailable probes retain their previous failure count, and a passing probe resets it. Tracer clusters are currently unavailable and reported as a coverage gap.

## Traction

`TractionEvidence` reads the existing Traction `GET /api/state` contract using a server-resolved Bearer credential.
Construct one instance for an authorized `{ accountId, workspaceId, projectIds }` binding and a trusted HTTPS origin.
Its credential callback receives that binding; neither the origin, token nor allowed project list may come from model output.
Traction currently uses a shared operator key, so filtering is an Ephyra disclosure boundary, **not upstream tenant authorization**.
Only configure a binding after its owner has authorized access to those projects. A multi-tenant deployment should use
separate authorized credentials/instances or a gateway that enforces this binding.

`read()` returns selected project source health, aggregate observations, units, authority, coverage and timestamps.
`search()` provides the same project context as evidence hits wrapped in an untrusted block. It does not claim a fingerprint,
trace, file or causal match. `fetch()` returns the exact cached JSON receipt; it never follows a caller-provided URI.
Persist fetched content in the trail journal before evicting the adapter. Global briefings and model interpretations are
excluded because they can combine projects outside the authorized binding.

HTTP and body reads have a total deadline, a byte limit, no redirects, no cookies and no automatic retry. Missing credentials,
a missing configured project, denied access, malformed data or an oversized response throw `Unverified`. A partial response
stays partial; stale/failed-source observations remain labelled historical. Only the latest 30 reported points per metric
are included, with `omittedPoints` explicit. Complete source coverage is not proof of complete instrumentation or a fix.
No poll, notification, direct PostHog request, paid inference or external write is triggered.

Fixture tests cover isolation, partial/stale evidence, malformed/oversized responses, timeouts and credential redaction.
These checks establish the local adapter contract, not live Traction/PostHog integration or production readiness.
