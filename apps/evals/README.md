# Ephyra evaluations

`@ephyra/evals` runs versioned, authored **synthetic** toy cases against the real
package APIs and server wiring. This is a regression/diagnostic suite, not a
representative production benchmark. Expected labels are inspectable in JSONL.
No production signals, approvals, runs, or Entire checkpoints are invented.

## Suites

- **triage**: 72 signals (24 scenarios × stack/log/OTLP representations), with
  duplicates, regressions, conflicting patches, noise, outages and security bugs.
  Exact route/link accuracy, severity band, actionable Brier loss, dangerous
  ignores, unnecessary escalation, top-label route/duplicate calibration, ECE
  reliability tables, confusion matrix, and one-at-a-time threshold sweeps.
  Sweeps are exploratory on the evaluation set, not newly validated thresholds.
- **injection**: eight signal/comment attacks, delimiter escape, fake authority,
  instruction separation, env/log canary redaction; live paired decision calls.
  Offline invariance is **unverified** (a scripted response cannot prove it).
- **proof**: actually run base/head probes/tests, then adversarially remove or
  mutate evidence. Check missing/unavailable evidence, nonfailing repro, failing
  head, real flaky rerun of the same probe, digest/head/revision substitution,
  new test failures and watch coverage gaps. Mutated bundles are attack inputs,
  not claimed observations. Results record uncovered enforcement gaps as failures.
- **agent**: sum and clamp seeded bugs in disposable local git repos. Research →
  repro → plan → patch uses package adapters and core transitions; proof uses the
  real builder. MockAgent drives offline scripted patches; these are not model
  success claims. The captured Amp reauthentication failure is explicitly replayed
  and unavailable. Plan/explanation quality uses the committed rubric; a judge
  has not been run, so quality scores remain null.
- **feedback**: production human/agent wiring, in-memory context and effect ledger:
  A/B/C bindings, stale approvals, artifact citation existence, timeouts/errors,
  failed turn handling, and reconciliation causes. Relative imports within apps
  are permitted by `test/boundaries.test.ts`; this suite imports only the narrow
  server wiring needed, not server startup, deployments or cloud integrations.

## Run

From the repository root:

```sh
rtk proxy bun apps/evals/src/main.ts run --suite all
rtk proxy bun test apps/evals
rtk proxy bun run --filter @ephyra/evals typecheck

rtk proxy env EPHYRA_LIVE=1 TYPESAFE_MODEL=jev-latest \
  TYPESAFE_API_KEY="$(rtk proxy skate get typesafe_api_key@secrets)" \
  bun apps/evals/src/main.ts run --suite triage --backend typesafe --live
rtk proxy env EPHYRA_LIVE=1 \
  CLOUDFLARE_ACCOUNT_ID="$(rtk proxy skate get cloudflare_account_id)" \
  CLOUDFLARE_AI_API_TOKEN="$(rtk proxy skate get cloudflare_ai_api_token@secrets)" \
  bun apps/evals/src/main.ts run --suite triage --backend workers-ai --live
rtk proxy env EPHYRA_LIVE=1 bun apps/evals/src/main.ts run --suite triage --backend parser --live
rtk proxy env EPHYRA_LIVE=1 bun apps/evals/src/main.ts run --suite agent --agent claude-code --live --limit 1
rtk proxy env EPHYRA_LIVE=1 bun apps/evals/src/main.ts run --suite agent --agent codex --live --limit 1
```

Default offline triage uses `fixture/oracle-v1` scripted oracle replay plus the
real parser. It tests decision-policy plumbing, **not** classifier quality.
`--backend parser` and `workers-ai` measure extraction only; TypeSafe measures
real decisions with parser extraction. `--backend typesafe-workers-ai` runs the full Clairic → Jev pipeline (and reserves $0.04/case). Extraction never impersonates a decision
backend. Exact returned identities partition every metric; unknown identities
remain conservative through the real policy. `TYPESAFE_MODEL` selects the
requested model; no hidden fallback. The live model listing currently exposes
aliases; results retain the resolved response identity.

`--limit` selects a prefix and hashes that exact selected corpus. Every run
checkpoints its cases to `results/<timestamp>-<suite>.json`, writes a short `.md`
report and a protobuf `.otlp` trace artifact. `results/` and disposable `.work/`
are ignored; only `BASELINE.md` is committed. Results include source SHA/dirty
status, actual outputs, timing, observed usage and explicit nulls.

Live runs require both `--live` and `EPHYRA_LIVE=1`. No retries on ambiguous
model writes. An unavailable provider trips a run-level circuit breaker.
A local exclusive lock prevents overlapping live runs. A persistent $10 ledger
reserves $0.02/model call, $0.04/injection pair and $2/agent fixture. These are
conservative reservations, **not measured spend**. Claude has a $0.50 per-step
CLI cap; Codex has no dollar cap exposed by this adapter, so its four brief steps
are bounded to 120 seconds each. Unknown billing remains unknown. Inspect the
ledger before another paid run; it never auto-resets. At most three fixtures per
agent are available by design (two seeded repos and the recorded Amp failure).
The local runner is for these trusted fixtures; it is not a hostile-code sandbox.

## Arize AX

Add `--arize` with inline `ARIZE_API_KEY` and `ARIZE_SPACE_ID` from skate.
Upload a saved run without repeating paid work:

```sh
rtk proxy env ARIZE_API_KEY="$(rtk proxy skate get arize_api_key)" \
  ARIZE_SPACE_ID="$(rtk proxy skate get arize_space_id)" \
  bun apps/evals/src/main.ts upload apps/evals/results/<run>.json
```

AX 0.39 uses the authenticated CLI profile and existing `kmannoel Space`.
Datasets are `ephyra-<suite>-<canonical-corpus-hash>`; each exact identity gets an
experiment named for suite, identity, source SHA and run ID. All example IDs are
joined/read back by `case_id`, never positional guesses. Results use flat
`eval.<metric>.score|label|explanation`. AX numeric columns with missing values
become label-only, preserving observed numbers in explanations rather than
coercing unavailable cases to zero. Experiments are confirmed with list readback.
Pending/ambiguous uploads require explicit reconciliation; never blindly retry.

Traces go to project **ephyra-evals**, using the profile's regional OTLP host,
OpenInference CHAIN/LLM/AGENT/TOOL spans, exact model response identities and
usage where reported. Explicit secrets and credential patterns are removed.
OTLP acknowledgement proves ingestion acceptance, not immediate UI indexing.
The CLI adapters currently echo requested model names; provider-resolved coding
model identities and hidden internal tool spans are unverified. Wrapper tool
commands and package calls are traced, with CLI diagnostics redacted.

## Read the scores

Accuracy/safety checks: 1 is good. Brier, ECE, dangerous_miss and over_escalation:
0 is good. Reliability rows show predicted probability versus observed frequency.
95% deterministic percentile-bootstrap intervals include the point estimate;
small, related toy cases make these descriptive rather than population claims.
Only scored observations enter quality denominators. Availability is counted
separately. All-null metrics are unverified, not zero. No human-quality judge,
production generalization, hosted runtime, deploy or landing is claimed.

The tests use fast-check for math/hash laws, actual local fixture probes and
fake AX/OTLP transports; no test makes a network call. Core changes: none.
