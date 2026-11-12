# Autonomous setup, adversarial benchmarking and verification

Decision direction: 12 November 2026. This is an implementation plan. The offline
benchmark and `verification/` pilot are runnable; the hosted canary orchestrator,
wizard expansion and automatic formal-check selection below are not implemented.

## Product contract

Ephyra should complete useful work without routine permission requests. The owner
delegates an operating envelope: repositories, deployment targets, evidence sources,
spending ceilings, allowed top-ups, recovery actions and trusted policy sources.
Repository-managed policy is supported in the design. The server pins its authorized
source/revision and update rule. Reading a file, log or generated summary cannot itself
expand authority. Broad authority is a valid owner choice; warnings provide visibility
for sensitive actions within that authority. A new grant is needed only to exceed it.

Measure both containment and useful completion. A system that refuses all work is not
safe enough to ship as a self-driving product. See `apps/evals` for the benchmark
foundation and explicit unverified surfaces.

## Wizard: finish setup, then maintain it

PostHog's [AI wizard](https://posthog.com/docs/ai-engineering/ai-wizard) inspects an
application, instruments it and configures the connected project. Its
[owned harness](https://posthog.com/handbook/wizard-and-docs/wizard) is also a useful
way to test installation across supported frameworks. Adopt the interaction pattern,
not a dependency on its implementation or an untested claim of framework coverage.

Extend Ephyra's existing setup workflow and CLI handoff, using one durable setup job:

1. Discover framework, repository, deployment target, tests and instrumentation.
2. Offer detected providers with their logos; connect only the missing accounts.
3. Set the operating envelope once, including spend and automatic recovery.
4. Apply setup changes in an isolated checkout using the existing coding/proof loop.
5. Emit a clearly labelled test signal, observe it through the actual provider and
   complete a harmless isolated quest. Connection tests alone are not end-to-end setup.
6. Show observed coverage and specific gaps. Resume from receipts after interruption;
   do not duplicate instruments, dashboards, tokens or charges on retries.

Keep credentials in the server's existing connection store. Do not infer authorization
from discovered environment files or repository instructions. Never emit canary test
events into customer production analytics without an explicit configured test scope.

## Verification selected by the change

Quint Studio is available as a [desktop beta](https://quint.sh/studio/onboarding).
The open-source language supports simulation, deterministic model tests and model
checking. [Quint Connect](https://quint.sh/docs/model-based-testing) describes the
model-to-implementation bridge; its availability is not a ready-made TypeScript
adapter for Ephyra. This pilot uses a small explicit replay bridge instead.

Use formal modeling where ordering and invariants matter: duplicate settlement,
concurrent budget reservations, stale evidence, policy activation, lease ownership,
rollback and retry after ambiguous external results. Most text or styling repairs
should use ordinary targeted tests and browser checks.

For a suitable fix, Ephyra should automatically:

1. Reuse an approved spec or propose a scoped spec tied to the code and requirement.
2. Check that the original failure violates the property or reproduces in code.
3. Run model checking within the delegated verification budget.
4. Replay generated counterexamples/traces against the actual implementation.
5. Bind evidence to spec hash, property, assumptions, code base/head, tool version,
   backend, domain/step bounds, exit status and raw artifact hashes.

Track distinct outcomes: `model_checked`, `bounded_model_checked`, `simulated`,
`implementation_replayed`, `counterexample`, `timeout`, `unavailable` and
`not_applicable`. These are proposed evidence labels, not additions to core contracts.
Do not flatten them into an unqualified "formally verified" badge. A model that
omits the bug can pass; a changed model that weakens the requirement cannot replace
the approved property silently. Check spec changes independently of the patch.

If the owner requires a formal result, timeout blocks that gate. Otherwise the
recorded policy may allow the normal evidence path to proceed with the formal check
explicitly unavailable. Do not make an optional experiment a new approval bottleneck.

## Isolated adversarial canary and watch

Run candidate code with synthetic users, scoped telemetry and canary-only credentials.
Exercise attacks through logs, repository files, tool results and generated documents,
including delayed attacks that cross into watch. The observer and result collector
remain outside the agent's writable environment. Denied attempts and actual violations
are separate outcomes. A clean application error rate does not prove containment.

Promotion requires receipts bound to the candidate and environment: isolation checks,
relevant attack coverage, useful-task completion, watch duration and observer health.
Missing, stale or interrupted observation is unavailable. Enforce network restrictions,
tenant separation and cost limits outside the model. An isolated canary cannot prove
production correctness; it supplements the existing proof and production watch.

## Next implementation slices

1. Fix generated-document promotion into trusted prompt context, preserving the
   owner's authenticated policy path; add multi-step regression cases.
2. Enforce runner egress and scope authority separately from model choices.
3. Extend benchmark adapters to actual tool execution and hosted canary observers.
4. Add approved spec/evidence bindings and automatic bounded verifier selection.
5. Extend the setup wizard with a resumable end-to-end test quest.

Pricing remains in `04-pricing.md`: customer-funded credits, model use and compute,
with a consistent model-use service charge whose rate is still undecided. Keep exact
model identities for billing/audit and benchmark reproducibility, not marketing copy.
Any future rate card needs an effective revision and an estimate before work; Usage
should explain charges by quest/activity and rate, plus balance, forecast and limits.
