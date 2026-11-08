# Repository setup and proactive bootstrap

`AutomaticSetup` records setup stages and artifacts under `refs/ephyra/setup/` in
the workspace's Git repository. `BootstrapAssessment` is an optional, additive
field on a setup run and is also saved as `ephyra/bootstrap.json`.

Bootstrap reads bounded source text from the pinned commit: documentation,
manifests, CI, telemetry hints and deployment hints. It reads at most twenty
sources, skips files larger than 48 KB, and retains at most 6,000 redacted
characters per source with its exact commit, path and content digest. Repository
text is untrusted context; it cannot change authority or run commands.

Coverage distinguishes an observed result from a configured connection, missing
capability or unknown coverage. Sandbox baseline observations require the pinned
head, successful verification and confirmed cleanup receipts. Telemetry,
deployment, knowledge and contact observations are supplied by the runtime's
`assess` hook. A source filename or an agent's statement cannot establish a
successful check, production ingestion or deployment.

Before an incident exists, bootstrap records owner requests for missing
capabilities and a factual question about a critical user journey. `respond`
accepts context answers only. Configuration requests resolve when a capability
or observation changes, never because an answer claims it was fixed. `report`
retains bounded, attributed agent or human context without promoting it to proof.
Both operations bind to the current setup and repository SHA and use stable
operation keys. Reusing a key with different content fails.

`reassess` checks current capabilities and coverage without allocating a sandbox
or invoking a model. The existing durable job queue schedules it every five
minutes by default. Settings changes can wake it immediately. Old jobs cannot
update a different setup snapshot. Restoration rechecks all ready and blocked
runs, while existing provisioning remains a separate operation.

The signed-in owner Inbox is the default contact route. When the owner explicitly
enables a People bridge with a saved token, `BootstrapContact.schedule` can enqueue
one bundled notice for the owner's area-authorized open requests. Other recipients
are excluded. The job contains only a digest, and every send rechecks the current
setup, SHA, request set, roster, connection revision and token. Its link returns to
the signed-in owner Inbox; no external answer token or invented incident trail is
created. `onAssessed` runs after the setup record is saved and only schedules work.

Bridge acknowledgement is recorded as its actual HTTP 2xx status, with a payload
digest and authority-bound request references. That acknowledgement does not prove
that a person read the notice. Pending or ambiguous outcomes, including timeouts,
changed authority and failed receipt saves, require reconciliation and are never
automatically resent after a restart. Changing the saved roster or connection
creates a new notice identity; unchanged assessments do not repeat delivery.

Focused offline tests cover source bounds and redaction, request identity,
attribution, stale heads, truthful baseline observation, restoration, deduplication,
runner-free periodic reassessment, post-persistence hooks and bridge acknowledgement
and refusal behavior. Live external connections, source instrumentation,
deliverability and production behavior remain unverified until the corresponding
runtime records an actual observation.
