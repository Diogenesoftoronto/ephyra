# Core

Core defines the shared schemas, ports, events, identifiers and a pure trail lifecycle.
`createTrail`, `transition` and `fold` are exported from `src/index.ts`. They return
commands; the caller persists events and executes effects. An effect is not proof that
its operation ran.

## Lifecycle

```text
sensed -> triaged -> researching -> hypothesised [A] -> reproducing
  -> planned [B] -> patching -> proving -> ready [C] -> landing
  -> watching -> closed
proving -- failed, attempts left --> patching
proving -- attempts exhausted --> parked
reproducing -- cannot reproduce --> parked
landing -- base moved --> patching (rebase)
watching -- regression --> rolled_back -- rollback completed --> researching (rev + 1)
active -- pause --> parked -- resume --> previous state
hypothesised/planned/ready -- claim review --> handed_off -- owner release --> previous state
active -- kill or checkpoint reject --> abandoned
```

Creation routes `auto_fix` and `research_only` to research, `human` to the inbox,
`ignore` to abandoned with a 24-hour fingerprint mute, and duplicates to a merge
command without a new trail. A conflict creates a parked child that waits for the
identified parent. `parent_trail_landed` must match that parent. A regression uses
`createTrail` with the matching **closed** `regressionTrail`: it preserves the old
identity and severity floor, attaches the signal, increments revision, and starts
research. Missing or mismatched source trails are rejected; ordinary transitions
absorb events in terminal states. For the separate sensed/triaged event path, supply
`trail_created.data.fingerprint` so an ignore decision can issue a real mute; it is
rejected if the fingerprint is unavailable. Regression reopening uses `createTrail`
because the event carries no original trail record.

Each checkpoint emits `request_checkpoint` with the policy's blocking flag. An
advisory checkpoint advances only if `autoDecision[A|B|C]` supplies a decision;
`autoDecisionC` remains supported as a C fallback. A shadow decision is recorded
without advancing, regardless of verdict. A research-only A approval parks and
notifies. Revising A, B or C returns respectively to research, planning or patching.
New proof, new signals during proof, base changes and human revisions invalidate a
previous C approval. Human revisions increment the revision when the head changes,
request proof, and require the current human owner. Successful proof keeps the held review at C;
failed proof clears ownership before normal patching or parking. The owner can also release while
already-enqueued proof continues, without starting or cancelling work. Claims populate the existing
`Trail.owner` field, are exclusive, and are limited to checkpoint states. Workflow actions and decisions
are refused while held; comments stay available. These are behavioural changes, with no new core
exported shapes. Spend requests retain their purpose and amount until a non-shadow
decision; approval starts the respondent run and rejection records the decision and
continues without the run. No proof is inferred from that decision.

Proof completion requires a recorded patch head, matching trail ID, revision, risk, base and head,
and the canonical SHA-256 digest of the exact bundle. `proofDigest`, `canonicalJson`, and `sha256Hex`
are pure exports. Tests compare the digest with Node's independent implementation and the journal's
actual proof pin. This binds a submitted bundle; it does not independently attest that its commands ran.

Rollback stores the reported watch evidence, asks for rollback, and waits for a
`rollback_completed` receipt before starting the next revision's research with that
evidence as a note. Clean watch completion registers a regression probe and resumes
dependents. Forge events must be translated by the forge adapter to the corresponding
core event. `fold` processes events in order with the supplied policy context and
returns the first invalid transition; callers replay with the same context to reproduce
the same decisions and effect keys.

## Effects

The machine can emit `run_triage`, `start_agent`, `run_proof`, `request_checkpoint`,
`request_spend`, `start_respondent_run`, `land`, `rebase`, `start_watch`, `rollback`,
`register_regression_probe`, `notify_inbox`, `stop_agent`, `merge_signal`,
`resume_dependents`, `mute_fingerprint`, `run_probes`, `reply_comment`, and
`deliver_child_evidence`. Keys have the form `trail:rev:type:event:occurrence`;
the event identifies the operation and occurrence distinguishes repeated commands of
the same type within that transition. Payload text is not included in the key. An
orchestrator must persist event IDs and use the keys to deduplicate external effects.

## Voice contracts

`voice.ts` exports additive schemas for capabilities, selected context, conversation turns, transcription, generated
audio and usage receipts, plus bounded recording/audio/text limits. A configured model is separate from a returned
engine identity; unavailable identity and cost are nullable. These contracts contain no I/O and grant no approval
or publication capability. Existing trail, proof and usage shapes are unchanged. The server and console integration
tests validate the wire contract with recorded fixtures; real speech providers and devices remain Unverified here.

## Tutor contracts

`tutor.ts` adds `TutorInput`, `TutorReply`, `TutorCapabilities`, `TutorBinding` and the pure `trailTutorBinding` helper.
Explanations bind to the revision, head, matching proof digest and update time. Replies carry source excerpts, a stale
flag and a model usage receipt. Existing trail, decision, proof and usage shapes are unchanged. These contracts grant
no action capability. Property tests reject proof bindings from a different revision or head; actual tutoring quality
and provider availability remain Unverified.

## Verification

`RunVisual` is an additive, bounded presentation schema (stable ID, title, HTML, initial height), exported from `src/index.ts`.
`AgentRunEvent.visual` is a new optional field; existing event variants are unchanged. A presentation is agent-authored
content and grants no proof, execution, authentication, or approval capability. Schema/property tests cover bounds and
exact round trips; runtime/browser isolation belongs to the console.

The offline tests exercise the lifecycle table, triage creation, checkpoints, rollback,
handoff, and randomized replay invariants. They verify pure decisions and schema
validity only. Actual agents, proof runs, forge writes, rollback, watch, inbox delivery,
respondent runs, and durable journal/outbox integration remain **Unverified** here.


## Automatic setup contracts (core changes)

New additive exports `SetupMode`, `SetupRequest` and `SetupRun` describe requested operation mode, recorded progress,
artifacts, source commit and readiness blockers. `RepositoryUpdate.discoverDefaultBranch` is a new optional field;
existing explicit-branch requests are unchanged. Setup readiness is configuration state, not evidence that a repair or
verification ran. The server validates these contracts against real local Git fixtures and the console consumes them.

## Account knowledge contracts (core changes)

`BootstrapCoverage`, `BootstrapRequest`, `BootstrapAssessment`, `BootstrapResponse` and
`BootstrapReport` are additive setup contracts. `SetupRun.bootstrap` is optional for
older records. Coverage, pinned source provenance and attributed context are distinct;
an answer or report never grants capability or establishes passing proof. The server's
offline tests verify persistence and runtime bindings; these schemas perform no I/O.

`knowledge.ts` adds `KnowledgeCatalog`, `KnowledgeSourceView`, `KnowledgeToolView`, `KnowledgeSearchTool`,
`KnowledgeSelection`, `KnowledgeConnection` and `KnowledgeUpdate`. `AccountSettings.knowledge` and
`EvidenceSource.search`'s `operationKey` are new optional fields. Existing callers and stored accounts remain valid.
Selections bind a workspace, exact source IDs and selected tool-definition hashes; schemas never grant upstream access.
Property tests cover explicit capabilities and selection validity. Gateway grants and MCP behavior remain Unverified by core.


## Repair-loop contracts (core changes)

Additive exports `UsageDelta`, `accountUsage`, `budgetBlocker` and `PolicyActivationReceipt` support durable usage and
reviewed policy activation. New events are `usage_recorded` and `policy_updated`. Optional budget fields retain observed
execution time, unknown cost/token counts and the known-cost requirement; optional `Trail.policyCommit` and
`Trail.workGeneration` bind work to the accepted policy and ownership epoch. Usage receipts remain recordable after
kill/close without reopening a terminal trail. Exceeded limits stop active work, including an owned human-revision proof.

`ProofBundle.awaitingHumanC` marks successful automated evidence with an outstanding human C decision; high/critical
C still requires an actual named human. Optional `LandingReceipt.externalVersion`/`externalRevision` bind conditional
external updates. `TelemetryConnection`/`TelemetryUpdate.deploymentUrl`, `Runner.exec`'s optional abort signal and
`AgentTask.budget.spendMicrousd` are backward-compatible fields. Pure/property tests verify accounting, limits and
state transitions; these schemas alone cannot attest provider usage, execution, deployment or remote authorization.
