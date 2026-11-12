---
title: How the pieces fit
summary: One pure state machine, a Git journal, a ledger of side effects, and adapters at the edges. Why it is built that way.
---

If you are going to let a system change your code, you should be able to see how it decides. Ephyra is small enough to hold in your head. This page is the map; the next three pages go into the state machine, the journal and the trust rules.

## The path of one event

Everything that happens to a quest follows the same five steps:

<!-- loop -->
1. **Event** Something happened
2. **State machine** Decides, purely
3. **Journal** Git, compare-and-swap
4. **Projection** What screens read
5. **Effects** Through the ledger

1. An **event** arrives: a signal was sensed, an agent step finished, a person approved, a watch saw a regression.
2. The **state machine** takes the quest and the event and returns the new quest plus a list of **effects**, things that should now happen. It is a pure function. It does no I/O and has no clock.
3. The transition is written to the quest's **journal** in Git with a compare-and-swap, together with its pending effects. If another writer got there first, the write fails and is retried against the new state.
4. A **projection** in the durable store is updated, so the inbox and lists do not have to read Git for every request.
5. **Effects** are delivered through an **operation ledger**, each under a stable key. A replay finds the key already there and does not repeat the side effect.

The consequence is the one you want: the same events in the same order always produce the same decisions. A quest's behavior can be reproduced from its journal.

## Why effects are separate from decisions

An effect is a request, such as "start the patch agent" or "land this commit". It is not evidence that the thing happened. That gap is deliberate.

External operations fail in a third way besides success and failure: the request was sent and no answer came back. Ephyra records that as an ambiguous outcome and stops for **reconciliation**. It never guesses, and it never blindly retries a write that timed out, because the write may have landed.

## The packages

The code is a Bun workspace. Dependencies point one way, and a test enforces it.

| Package | What it holds |
|---|---|
| `@ephyra/core` | The shared contracts: schemas, events, ports, identifiers, and the pure state machine. Depends only on `zod`. No I/O. |
| `@ephyra/policy` | Pure rules: autonomy parsing, triage, the proof matrix, watch boundaries. |
| `@ephyra/journal` | Git plumbing that stores quests under `refs/ephyra/`. |
| `@ephyra/ingest` | OTLP logs and traces into redacted, fingerprinted signals. |
| `@ephyra/models` | A registry of extraction and decision models, with identity checks. |
| `@ephyra/forge` | Landing and rollback on plain Git, with Radicle and Tangled adapters. |
| `@ephyra/runner` | Where code executes: a trusted local runner, Railway sandboxes, Not Organic scripts. |
| `@ephyra/agent` | Prompts with untrusted blocks, the coding-agent CLIs, and the proof builder. |
| `@ephyra/evidence` | Sources research reads: Git history, telemetry, earlier quests, studies, the watch collector. |

`core` is the only thing the other packages may import. They never import each other. `apps/server` composes them; `apps/cli` uses `core`, `policy` and the server's HTTP API, over HTTP.

## Ports and adapters

Every integration is an interface in `packages/core/src/ports.ts`, with implementations injected at the edge. The logic that decides is written against the interface, so it can be tested without a network, and a new forge, runner or model is a new adapter and not a change to the loop.

## The server

`apps/server` wires it together:

| Concern | File |
|---|---|
| Composition root: configuration → stores → engine → handlers → HTTP | `src/compose.ts` |
| The engine and job loop | `src/wiring/runtime.ts` |
| Signal → triage → quest | `src/wiring/intake.ts` |
| Agent steps and proof | `src/wiring/agents.ts` |
| Checkpoints, inbox, decisions, audit | `src/wiring/human.ts` |
| Landing, watch, rollback | `src/wiring/landing.ts` |
| Durable stores | `convex/` and `src/convex/stores.ts` |

Long work (triage, agent steps, proof, the watch) runs as jobs on a durable queue.

## Where state lives

| What | Where | Why |
|---|---|---|
| A quest's history, files, proof and decisions | Git, under `refs/ephyra/` | It travels with the repository and can be read without Ephyra. |
| Signals, projections, the inbox, jobs, the operation ledger, the audit log | Convex | Queries, queues and transactions. |
| Repository mirrors and local operation records | `EPHYRA_DATA_DIR` | Working copies for the journal and forge. |
| Credentials | The control plane's environment or credential references | Never in Git, journals, logs or prompts. |

The audit log is hash-chained, so an edited or removed entry is detectable.

## One worker at a time

Each workspace has one active worker, holding a lease with a **fencing generation** and a heartbeat. A second process can serve reads and enqueue work, but cannot claim jobs, change quests or write transcripts.

If the worker loses its lease, its jobs, polling and runner handles stop. Jobs from an expired or unknown owner are dead-lettered for reconciliation. On start, the new worker repairs projections from the Git journals, reloads the reviewed policy, and delivers only effects that are current and were never started.

## Models and identity

A model is recorded by the exact identity its backend returned, such as `judgement-jev/jev-1.14`. Confidence thresholds are keyed by that identity. If a backend starts answering as a different model, its thresholds do not carry over, and there is no silent fallback to another model.

## Next

- [The state machine in full](./lifecycle)
- [What the journal looks like in Git](./journal)
- [The rules that keep evidence honest](./trust)
