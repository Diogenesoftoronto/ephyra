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
active -- claim --> handed_off -- release --> previous state
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
request proof, and keep the trail handed off; a completed proof sets the state to
resume on release. Spend requests retain their purpose and amount until a non-shadow
decision; approval starts the respondent run and rejection records the decision and
continues without the run. No proof is inferred from that decision.

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

## Verification

The offline tests exercise the lifecycle table, triage creation, checkpoints, rollback,
handoff, and randomized replay invariants. They verify pure decisions and schema
validity only. Actual agents, proof runs, forge writes, rollback, watch, inbox delivery,
respondent runs, and durable journal/outbox integration remain **Unverified** here.
