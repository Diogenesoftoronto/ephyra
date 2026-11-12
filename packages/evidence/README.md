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

## PostHog

`PostHogEvidence` implements direct investigation of recorded `$exception` events for one fixed PostHog project.
Configure `{ origin, projectId, scope: { accountId, workspaceId }, credential, authorize, fetcher }` on the server.
The credential and authorization callbacks receive the entire binding, including origin and project. They must verify
that the current connection still belongs to that account/workspace and permits that project. Use a project-restricted
personal API key or OAuth access token with `query:read`. The adapter never accepts model-provided SQL, URLs or projects.

Inject a transport that resolves **and pins public DNS addresses**, such as the server's `publicHttpsFetch`. The adapter
requires a public HTTPS hostname without credentials, ports, paths or IP literals, but hostname syntax alone cannot
prevent DNS rebinding; transport enforcement is required. Custom public self-hosted origins are supported by the same contract.

`search()` fetches the latest 50 recorded exceptions in a bounded window and ranks their recorded text locally.
It includes a coverage receipt for an empty result. `fetch(hit)` only accepts receipts issued by that instance and
returns immutable JSON; caller-provided URIs and snippets are ignored. Set `includeRecordings: true` only when the
connection permits `session_recording:read`: fetching a hit with a recorded session ID then reads recording metadata
and up to 20 captured console errors. Person data, arbitrary event properties, frame variables, replay contents and
traces are excluded. Session IDs and links do not prove a recording exists; unavailable metadata, missing scopes,
expired logs, disabled capture and additional log pages remain explicit. First fetch fixes the receipt's content;
repeat fetches recheck authorization before disclosing cached bytes.

`exceptions(since?, cursor?)` returns a `PostHogExceptionBatch` for signal ingestion, **not** synthesized core signals.
It reads at most 50 events in ascending `(timestamp, uuid)` order, with a 51st row as a continuation sentinel. Persist
`nextCursor` and drain it before advancing `nextSince`. Cursors bind the source, fixed window, UTC microsecond timestamp
and event UUID, preserving events with equal timestamps. New polling windows must overlap to catch ingestion delays
and deduplicate by recorded event ID. Retention is unknown; the default window is 24 hours and requests older than
seven days are explicitly clamped. Research samples use descending order; they do not claim to search all history.

Each operation has one total deadline (10 seconds by default, configurable up to 25 seconds), a streamed byte limit
(1 MB by default, maximum 2 MB), no redirects, no cookies and no automatic retries. Query requests use the read-only
`HogQLQuery` endpoint with constant columns/predicates and validated canonical timestamp/UUID literals. No free-form
query text or fingerprint is inserted into SQL. HTTP errors throw `PostHogAccessError` (an `Unverified`) with a safe
status, including `missing_credential`, `missing_scope`, `denied`, `rate_limited`, `timeout` or `invalid_response`.
Authorization is rechecked before requests and before both fresh and cached evidence is released.
`assertAuthorized()` exposes the same current grant check for the server ingestion boundary.

Selected text is bounded, reflected credentials and common secret/email/phone patterns are masked, URL credentials
and query strings are removed, and prompt snippets are escaped inside an untrusted wrapper. This is a limited
projection and defense in depth, not a complete PII detector: configure capture-side scrubbing for sensitive data.
The batch records query digest, retrieval time, computation freshness, window, clipping and coverage limits.
No recorded errors is never proof that an application is healthy or a repair succeeded.

The implementation follows PostHog's official [SQL/query contract](https://posthog.com/docs/sql),
[query execution and caching](https://posthog.com/docs/api/queries),
[exception event fields](https://posthog.com/docs/error-tracking/issues-and-exceptions),
[session recording and console-log API](https://posthog.com/docs/api/session-recordings), and
[API scopes](https://posthog.com/docs/api/scopes). The [browser SDK exception implementation](https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/posthog-exceptions.ts)
confirms ISO timestamps for exception steps. Fixture tests cover pagination, scope isolation, SQL injection,
revocation, redaction, unavailable/expired data, malformed and oversized responses, and deadlines. No live project,
credential, event, recording or provider integration was read or verified in this implementation pass.

## Additional telemetry providers

`TelemetryProviderEvidence` supplies read-only `observe(since)`, `verify()`, `search()` and receipt-bound `fetch()` for these connections:

| Provider | Project field | Credentials | Query path |
|---|---|---|---|
| Sentry | `organization/project` | `apiKey`: token with project read access | Project error events, including selected exception frames and release/device tags |
| Firebase Crashlytics | Google Cloud project ID | `serviceAccountJson`: service account with Logs Viewer access, or temporary `apiKey`: OAuth access token | Cloud Logging `entries:list`, restricted to the Crashlytics events log |
| Grafana Loki | `service_name` label value | `apiKey`; optional `username` for Basic auth | LogQL `query_range`; optional configured `query` overrides the service selector |
| Axiom | Dataset name | `apiKey`: scoped query API token | Regional edge APL query; legacy `api.axiom.co` also accepted with an explicit region/cost-limit warning |
| Better Stack | Hot-storage source table such as `t123456_mobile_logs` | `username` and `apiKey`: SQL connection password | Read-only ClickHouse HTTP query to `remote(table)` |
| Datadog | Service name | `apiKey` and `applicationKey` with log read permission | Logs v2 search; optional configured `query` narrows the service |
| BugSnag | Project ID | `apiKey`: personal auth token | Project error summaries, identified by issue and last-seen time |

Credentials are resolved against an immutable account/workspace/provider/destination binding and checked before dispatch and after response. Production callers must inject the public-DNS-pinning transport. Redirects, malformed responses, oversized bodies, unrecognised receipts and revoked grants fail closed. Provider error bodies are not exposed. Only selected diagnostic fields are retained; exact credentials and common secret/email patterns are scrubbed. This is not comprehensive removal of sensitive information from arbitrary free-text logs; configure source-side redaction too.

The Crashlytics service-account flow signs a short-lived RS256 assertion for the fixed Google OAuth endpoint with only `logging.read` scope. It ignores `token_uri` in the supplied JSON, caches the returned access token for at most one hour, and refreshes before expiry. Manual OAuth tokens need replacement when they expire. Firebase Cloud Logging export must already be enabled; Ephyra does not enable exports or change provider settings.

**Coverage:** queries inspect a recent sample of at most 50 records (Sentry full-event pages are capped at 10), with a maximum seven-day window. Every observation declares partial coverage: pagination, delayed delivery, sampling and retention are not assumed complete. General log stores create signals only for explicit error/fatal/critical/alert/emergency/panic severities. Missing severity is not guessed from text. Better Stack archive storage is excluded. BugSnag results are issue summaries, not individual occurrences. Empty successful queries verify access only, never instrumentation, application health, or a completed repair. Provider queries can incur costs.

**Verified offline:** provider-shaped fixtures for all seven request/response contracts; scope and revocation checks; credential redaction properties; query identifier validation; response size limits; immutable evidence receipts; severity filtering; Google JWT signature, fixed audience, caching and refresh. Run `bun test packages/evidence` and `bun run --filter @ephyra/evidence typecheck`.

**Unverified:** live provider credentials, export permissions/delays, SDK installation, symbols/source-map upload, regional availability, billing, large-volume completeness, native-device crashes and delivery. No external provider writes or live requests run in tests.

API references consulted for these contracts:
- [Sentry project error events](https://docs.sentry.io/api/events/list-a-projects-error-events/)
- [Cloud Logging entries.list](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list) and [Crashlytics export filters](https://firebase.google.com/docs/crashlytics/cloud-logging-filtering-and-log-based-metrics)
- [Grafana Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)
- [Axiom regional queries](https://axiom.co/docs/restapi/endpoints/queryEdge)
- [Better Stack SQL API](https://betterstack.com/docs/logs/query-api/connect-remotely/)
- [Datadog logs search](https://docs.datadoghq.com/api/latest/logs/)
- [BugSnag Data Access API](https://developer.smartbear.com/bugsnag/docs/data-access)
