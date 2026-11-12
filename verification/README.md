# Quint proof-binding pilot

This is a small, executable experiment, not a formal verification of Ephyra as a
whole or of an LLM's prompt-injection resistance. No production behavior is changed.

`proof_gate.qnt` models the proof → approval → landing → watch part of the core
lifecycle. It explores three patch revisions, two base identities, independently
chosen proof heads/revisions/bases, base movement before/during landing and repeated
stale receipts. Head identity is represented by revision. It assumes a low-risk
authorized quest, sufficient passing evidence, available budget and authenticated
events. Arbitrary SHAs, failing evidence, time, risk, policy changes, real deployments,
provider permissions, isolation and concurrency are outside this abstraction.

The property is: a state at ready/landing/watching/closed has proof matching the
current base, head and revision. `completionStep` and `autonomousCompletionTest`
ensure successful progress is possible without human checkpoint approval. They are
existence checks, not a fairness or liveness proof for every execution.

`replay.ts` replays generated ITF inputs against the real `core.transition` and
compares state, base, head and revision after every action, plus landing/watch effects.
It counts model stutters separately from actual reducer calls. It deliberately assumes
proof sufficiency and injects labelled fixture receipts; it does not assert those
receipts were collected from a real deployment. This is a trace conformance check,
not a mathematical refinement proof. `completion.itf.json` is a generated positive
control; modified traces in the unit tests are explicitly adversarial fixtures.

## Reproduce

From the repository root (Node/npm, Bun and Java 17+ required). The first CLI/checker
invocation downloads tools; ordinary Bun unit tests do not access the network.
Quint is pinned without adding a dependency to the shared workspace.

```sh
rtk proxy npx --yes @informalsystems/quint@0.33.1 test verification/proof_gate.qnt --backend typescript
rtk proxy npx --yes @informalsystems/quint@0.33.1 verify verification/proof_gate.qnt --backend tlc --invariant freshProof --tlc-config verification/tlc.json
rtk proxy mkdir -p verification/.generated
rtk proxy npx --yes @informalsystems/quint@0.33.1 run verification/proof_gate.qnt --backend typescript --invariant freshProof --witnesses completed --seed 7122026 --max-samples 1000 --max-steps 30 --n-traces 50 --out-itf 'verification/.generated/trace-{seq}.itf.json' --verbosity 1
rtk proxy bun verification/replay.ts verification/.generated/trace-*.itf.json
rtk proxy npx --yes @informalsystems/quint@0.33.1 run verification/proof_gate.qnt --backend typescript --step completionStep --invariant freshProof --seed 7122026 --max-samples 1 --max-steps 4 --out-itf verification/.generated/completion.itf.json --verbosity 1
rtk proxy bun verification/replay.ts verification/.generated/completion.itf.json
rtk proxy bun test ./verification
rtk proxy bun x tsc --noEmit -p verification/tsconfig.json
```

The TLC configuration uses one worker and 512 MB heap. TLC enumerates this finite
state space; this is not an unbounded verification of the implementation. Random
simulation is reported separately. Tool-generated `_apalache-out` logs are local
artifacts and should not be committed.

For a negative control, copy the model into `.generated`, remove only `and h == revision`
from `accepted`, and run simulation with `--main proof_gate` and the same invariant
and seed. A nonzero exit counts only when it reports an invariant violation and
produces the counterexample, not when parsing or the tool fails.

## Observed on 12 November 2026

- Quint 0.33.1 / Apalache compiler 0.62.4 / TLC, one worker, 512 MB heap:
  4,231 generated states; 87 distinct; queue exhausted; `freshProof` holds.
- Deterministic model tests: 2 passed.
- Simulation: 1,000 traces × up to 30 steps, seed 7122026; no violation;
  completed state witnessed in 26 traces. This percentage is not task success rate.
- Replay of 50 selected simulation traces: 1,500 model steps comprise 385 actual
  reducer calls and 1,115 stutters; 127 proof inputs rejected. These selected traces did not complete, so completion
  was verified separately by a four-step generated positive control.
- Head-binding mutation: simulation found an invariant violation (expected failure).
- Replay unit tests cover successful automatic completion, mismatch detection,
  stale receipt rejection and malformed trace rejection.

Live coding-model resistance, cloud canary isolation, actual proof collection and
deployment/watch behavior remain **unverified**. Tool availability and Studio UI/MCP
integration are not inferred from this CLI experiment.
