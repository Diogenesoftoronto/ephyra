---
title: The quest state machine
summary: Every state a quest can be in, what moves it, and the effects each transition asks for.
---

When a quest does something you did not expect, the answer is in this machine. It is a pure function in `packages/core/src/lifecycle.ts`: given a quest and an event, it returns the next quest and the effects to carry out.

## The main line

```text
sensed → triaged → researching → hypothesised [A] → reproducing
       → planned [B] → patching → proving → ready [C] → landing
       → watching → closed
```

`[A]`, `[B]` and `[C]` are the checkpoints. At each one the machine emits a checkpoint request carrying the policy's blocking flag.

## The branches

| From | When | To |
|---|---|---|
| `proving` | Proof failed, attempts remain | `patching` |
| `proving` | Attempts exhausted | `parked` |
| `reproducing` | Cannot reproduce | `parked` |
| `landing` | The base branch moved | `patching`, to rebase |
| `watching` | Regression | `rolled_back` |
| `rolled_back` | Rollback confirmed complete | `researching`, at revision + 1 |
| any active state | Paused | `parked` |
| `parked` | Resumed | the state it was in |
| `hypothesised`, `planned`, `ready` | A person claims the review | `handed_off` |
| `handed_off` | The owner releases it | the state it was in |
| any active state | Killed, or a checkpoint rejected | `abandoned` |

`closed` and `abandoned` are terminal. Events that arrive afterwards are absorbed without changing the quest, with one exception: usage receipts can still be recorded, so late costs are not lost.

## All sixteen states

| State | Meaning |
|---|---|
| `sensed` | A signal arrived. |
| `triaged` | A route was chosen. |
| `researching` | Evidence is being gathered. |
| `hypothesised` | A hypothesis is written. Checkpoint A. |
| `reproducing` | A failing check is being written. |
| `planned` | The failure is reproduced and a plan exists. Checkpoint B. |
| `patching` | A fix is being written. |
| `proving` | The proof bundle is being assembled. |
| `ready` | Proof is complete. Checkpoint C. |
| `landing` | The reviewed commit is being written. |
| `watching` | Deployed and under observation. |
| `closed` | Watched clean. Terminal. |
| `rolled_back` | A regression was seen; waiting for the rollback receipt. |
| `parked` | Stopped, with a reason. Resumable. |
| `handed_off` | A person holds the review. |
| `abandoned` | Killed or rejected. Terminal. |

## How a quest starts

Triage picks a route when a quest is created:

| Route | Result |
|---|---|
| `auto_fix`, `research_only` | Starts research. |
| `human` | Goes to the inbox. |
| `ignore` | Abandoned, and the fingerprint is muted for 24 hours. |
| duplicate | Merged into the existing quest; no new one. |
| conflict | A parked child that waits for its parent to land. |

A **regression** reopens the matching closed quest. It keeps its identity and its severity floor, attaches the new signal, increments the revision and starts research again.

## Checkpoints in detail

- A **blocking** checkpoint waits for a person.
- An **advisory** checkpoint advances only if an automatic decision is supplied for it. Those come from a durable model evaluation with its own evidence checks.
- In **shadow** mode a decision is recorded and the quest does not advance, whatever the verdict.
- **Revise** at A, B or C returns to research, planning or patching.
- A research-only quest that is approved at A parks and notifies you. It was never going to patch.

### What invalidates an approval at C

An earlier C approval stops counting when any of these happen: new proof, a new signal during proof, a change to the base, or a human revision. A human revision that changes the head increments the revision and requests proof again.

### Claimed reviews

A claim is exclusive and only possible at a checkpoint. While it is held, workflow actions and decisions are refused; comments still work. If proof succeeds during a claim, the review stays held at C. If it fails, ownership is cleared before the quest returns to patching or parks.

## Proof completion

For proof to complete, the machine requires a recorded patch head, and a bundle whose quest ID, revision, risk, base and head match, along with the canonical SHA-256 digest of that exact bundle. This binds a submitted bundle. It does not independently attest that its commands ran.

## Effects

A transition can ask for any of these:

| Effect | Asks for |
|---|---|
| `run_triage` | A routing decision. |
| `start_agent`, `stop_agent` | An agent step to begin or be aborted. |
| `run_proof`, `run_probes` | The proof bundle or specific probes. |
| `request_checkpoint` | A checkpoint request, with its blocking flag. |
| `request_spend`, `start_respondent_run` | A spend approval, then the study it paid for. |
| `land`, `rebase`, `rollback` | Forge writes. |
| `start_watch`, `register_regression_probe` | Post-landing observation, and keeping the reproduction. |
| `notify_inbox`, `reply_comment` | Messages to people. |
| `merge_signal`, `mute_fingerprint` | Signal bookkeeping. |
| `resume_dependents`, `deliver_child_evidence` | Coordination between related quests. |

Each effect has a key of the form `trail:rev:type:event:occurrence`. The event identifies the operation; the occurrence separates repeated commands of the same type in one transition. Payload text is not part of the key. The orchestrator persists event IDs and uses the keys to deliver each effect once.

## Replay

`fold` runs a list of events through the machine in order with a given policy and returns the first invalid transition, if any. Replaying the same events with the same policy reproduces the same decisions and the same effect keys. That is what makes recovery from the journal possible.

## What this does not verify

The machine's tests cover the transition table, creation, checkpoints, rollback, handoff and randomized replay. They verify decisions and schemas only. Whether an agent actually ran, a forge write happened or a watch observed anything is established elsewhere, by the adapters and the ledger.

## Next

- [Where each transition is stored](./journal)
- [The same states, seen as a reviewer](./concepts#where-a-quest-can-stop)
