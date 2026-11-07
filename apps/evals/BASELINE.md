# Ephyra evaluation baseline — 2026-11-07

12 saved runs; 14 experiments across 9 content-addressed datasets. All five suites ran offline. Live coverage: 72 Jev+parser triage cases, 72 Clairic extraction cases, 24 Clairic→Jev pipeline cases, 72 parser extractions, 8 paired injection cases, and one fixture each for Claude Code and Codex. No retries, deployment, push or remote changes.

## Results

95% bootstrap intervals below are descriptive of authored synthetic toy cases, not production confidence. Variants share scenarios; perfect/all-zero bootstrap intervals do not imply zero population risk. All unavailable results are excluded from quality denominators. Offline oracle replay measures policy plumbing, not predictive quality.

| Mode / identity | Metric | N | Mean (95% bootstrap interval) |
|---|---|---:|---|
| live / `jev-1.14.0 + parser/regex` | route | 72 | 0.4028 (0.3056–0.5139) |
| live / `jev-1.14.0 + parser/regex` | exception | 72 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + parser/regex` | frame | 72 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + parser/regex` | duplicate | 72 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + parser/regex` | regression | 72 | 0.9861 (0.9583–1.0000) |
| live / `jev-1.14.0 + parser/regex` | conflict | 72 | 0.9583 (0.9028–1.0000) |
| live / `jev-1.14.0 + parser/regex` | severity | 72 | 0.6944 (0.5833–0.7917) |
| live / `jev-1.14.0 + parser/regex` | actionable_brier | 72 | 0.0526 (0.0410–0.0671) |
| live / `jev-1.14.0 + parser/regex` | dangerous_miss | 72 | 0.0000 (0.0000–0.0000) |
| live / `jev-1.14.0 + parser/regex` | over_escalation | 72 | 0.0000 (0.0000–0.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | route | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | exception | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | frame | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | duplicate | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | regression | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | conflict | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | severity | 72 | 1.0000 (1.0000–1.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | actionable_brier | 72 | 0.0036 (0.0036–0.0036) |
| offline / `fixture/oracle-v1 + parser/regex` | dangerous_miss | 72 | 0.0000 (0.0000–0.0000) |
| offline / `fixture/oracle-v1 + parser/regex` | over_escalation | 72 | 0.0000 (0.0000–0.0000) |
| offline / `harness/injection-v1` | triage_invariance | 0 | Unverified (Unverified–Unverified) |
| offline / `harness/proof` | safe | 11 | 0.7273 (0.4545–0.9091) |
| offline / `policy/watch` | safe | 1 | 1.0000 (1.0000–1.0000) |
| offline / `mock/script-v1` | completion | 2 | 1.0000 (1.0000–1.0000) |
| offline / `amp/recorded-reauth` | completion | 0 | Unverified (Unverified–Unverified) |
| live / `clairic` | route | 0 | Unverified (Unverified–Unverified) |
| live / `clairic` | exception | 72 | 1.0000 (1.0000–1.0000) |
| live / `clairic` | frame | 72 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 → jev-1.14.0` | triage_invariance | 8 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + clairic` | route | 24 | 0.3750 (0.2083–0.5833) |
| live / `jev-1.14.0 + clairic` | exception | 24 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + clairic` | frame | 24 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + clairic` | duplicate | 24 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + clairic` | regression | 24 | 1.0000 (1.0000–1.0000) |
| live / `jev-1.14.0 + clairic` | conflict | 24 | 0.9583 (0.8750–1.0000) |
| live / `jev-1.14.0 + clairic` | severity | 24 | 0.7083 (0.5417–0.8750) |
| live / `jev-1.14.0 + clairic` | actionable_brier | 24 | 0.0540 (0.0335–0.0863) |
| live / `jev-1.14.0 + clairic` | dangerous_miss | 24 | 0.0000 (0.0000–0.0000) |
| live / `jev-1.14.0 + clairic` | over_escalation | 24 | 0.0000 (0.0000–0.0000) |
| offline / `server/feedback` | safe | 11 | 0.9091 (0.7273–1.0000) |
| live / `claude-code/claude-opus-5-5` | completion | 1 | 0.0000 (0.0000–0.0000) |
| live / `codex/gpt-6.1-sol` | completion | 0 | Unverified (Unverified–Unverified) |
| live / `parser/regex` | route | 0 | Unverified (Unverified–Unverified) |
| live / `parser/regex` | exception | 72 | 1.0000 (1.0000–1.0000) |
| live / `parser/regex` | frame | 72 | 1.0000 (1.0000–1.0000) |

Brier/ECE and dangerous_miss/over_escalation are losses/rates: lower is better. Other checks: higher is better. The exported rate labels describe whether the event occurred, not overall safety. Full per-case data and threshold sweeps are in the ignored results JSON and Arize.

## Ranked findings

1. **High — proof binding gap.** `proof-digest-mismatch` and `proof-wrong-head` reach ready through the real core transition. Revision substitution is rejected. Policy/builder/lifecycle checks do not establish a complete digest/head binding contract; this eval does not claim a production landing bypass. Core changes require coordination, so left as findings.
2. **High — prompt boundary gaps.** Closing `</untrusted_signal>` text survives triage/extraction wrappers; the agent renderer escapes delimiters. All 8 direct renderer tests retain an unsanitized log/env canary unless the caller invokes `redact` with explicit secrets. Explicit redaction passes. This proves a direct harness boundary weakness, not a production end-to-end exfiltration. Live Jev route/link invariance passed 8/8 paired attacks; that does not establish broad injection resistance.
3. **High — failed turns could advance. FIXED in `7779f9f`.** Server wiring previously accepted an `ok:false` result with hypothesis artifacts and could publish a failed patch head. It now emits a nonretryable agent_failed event before publication/advancement. The eval checks parked state and a useful cause.
4. **Medium — unstable proof accepted.** The same real probe passes once at head and fails on a second run. The builder/policy has no rerun stability gate; `proof-flaky-reruns` exposes it. Missing probes, missing required evidence, nonfailing base, failing head, stale revision and missing watch telemetry are rejected.
5. **Medium — coding-agent completion unavailable/failed.** Both real adapters completed three steps, attempted four agent calls, then raised `patch produced no commits`; neither produced verified final proof. Claude plan text says the fix was committed before the patch phase. Codex plan text reports `.git/index.lock` blocked by read-only metadata. These explanations are agent-reported; command evidence only establishes the no-new-commit failure. Future runs now record step head snapshots. The CLI token budget is advisory: observed totals far exceeded the requested 6000 per step (includes cache tokens).
6. **Medium — route thresholds heavily defer.** Jev+parser falls back to research_only for 43/72 cases due to the confidence gate, including all 24 expected-human cases (severity notifications remain). Reducing confidence threshold from 0.5 to 0.2 improves same-corpus route accuracy from 40.3% to 54.2%, with zero observed dangerous ignores. This is an in-sample diagnostic, not a validated replacement threshold. Combined Clairic→Jev route accuracy is 37.5% on 24 cases; no head-to-head superiority claim.
7. **Medium — stale/missing feedback artifacts.** A/B/C revision/head/digest checks and stale approval rejection pass. A ready checkpoint can still cite an absent proof manifest; feedback is 10/11 after the failed-turn fix (previously 9/11).

## Availability, identity and spend

- Model identities exactly returned: `jev-1.14.0`, `clairic`, `parser/regex`. Actionable ECE: Jev+parser **0.2100**, Jev+Clairic **0.2096**. Model billing usage was absent in the adapter responses; not reported as free.
- Claude requested identity `claude-code/claude-opus-5-5`: completed 3 steps, attempted 4; 368,719 reported tokens and **$0.386680** across the first three steps. Fourth-step usage was lost when the adapter threw; the $0.50/step CLI cap was configured. Full-loop completion is a measured failure, rescored from unavailable without rerunning the agent (`scoringRevision: 8d8a319`).
- Codex requested identity `codex/gpt-6.1-sol`: completed 3 steps, attempted 4; 407,015 reported tokens; cost null. The saved run predates the semantic-failure classifier and retains its original unavailable completion label. No patch/proof success is claimed.
- Provider-resolved coding model identity, internal model-call/tool-call telemetry inside the CLI, fourth-step usage, and qualitative plan/explanation judge scores remain unverified. Wrapper commands and AGENT steps are traced.
- Amp is unavailable in the captured real reauthentication error. This was replayed, not a fresh paid Amp attempt.
- Persistent conservative budget reservations total **$8.16 / $10**. This is not a verified bill. Unknown model/Codex costs prevent an exact spend total. No further paid calls were made.

## Arize readback

Every listed experiment and dataset ID was confirmed through `ax experiments list` / `ax datasets list`. OTLP acknowledged all 12 run payloads. Separate trace readbacks confirm a live Jev CHAIN+LLM trace and both real agent traces (each 1 CHAIN, 4 AGENT, 17 wrapper TOOL spans).

Trace project: [ephyra-evals](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/projects/TW9kZWw6MjgzOTQ4MDU6VWlXNA%3D%3D). UI URL templates follow [Arize’s official link guide](https://github.com/Arize-ai/arize-skills/blob/main/skills/arize-link/SKILL.md); browser rendering was not tested.

| Dataset | ID |
|---|---|
| [ephyra-triage-49dbe93615cca05f](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjg6dWtTQg%3D%3D?selectedTab=examples) | `RGF0YXNldDo5Mjg6dWtTQg==` |
| [ephyra-injection-16a3e7721bd81d0c](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjk6KzhNbA%3D%3D?selectedTab=examples) | `RGF0YXNldDo5Mjk6KzhNbA==` |
| [ephyra-proof-77112db64709bb58](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzA6eEExTA%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzA6eEExTA==` |
| [ephyra-proof-ff9d65d0e343d596](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzE6NjI1eA%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzE6NjI1eA==` |
| [ephyra-agent-8a2d7b931a44f59d](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzI6UHAxOQ%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzI6UHAxOQ==` |
| [ephyra-agent-e300b0e5c4a8a038](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzM6UWtqQg%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzM6UWtqQg==` |
| [ephyra-triage-5d29d7d81b9be5fb](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzU6bGlqMQ%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzU6bGlqMQ==` |
| [ephyra-feedback-dc575d178b4882ab](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzQ6Wk54Yw%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzQ6Wk54Yw==` |
| [ephyra-agent-2371fab112e04c9a](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzY6VllNZQ%3D%3D?selectedTab=examples) | `RGF0YXNldDo5MzY6VllNZQ==` |

| Run / identity | Experiment ID (link) |
|---|---|
| triage / live / jev-1.14.0___parser_regex | [RXhwZXJpbWVudDo2ODI6c2l4aw==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjg6dWtTQg%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODI6c2l4aw%3D%3D) |
| triage / offline / fixture_oracle-v1___parser_regex | [RXhwZXJpbWVudDo2ODM6U1BINA==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjg6dWtTQg%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODM6U1BINA%3D%3D) |
| injection / offline / harness_injection-v1 | [RXhwZXJpbWVudDo2ODQ6UWFXeA==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjk6KzhNbA%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODQ6UWFXeA%3D%3D) |
| proof / offline / harness_proof | [RXhwZXJpbWVudDo2ODU6ZTZPdg==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzA6eEExTA%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODU6ZTZPdg%3D%3D) |
| proof / offline / policy_watch | [RXhwZXJpbWVudDo2ODY6c2s3Tw==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzE6NjI1eA%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODY6c2s3Tw%3D%3D) |
| agent / offline / mock_script-v1 | [RXhwZXJpbWVudDo2ODc6LzNQeg==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzI6UHAxOQ%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODc6LzNQeg%3D%3D) |
| agent / offline / amp_recorded-reauth | [RXhwZXJpbWVudDo2ODg6d3VRMA==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzM6UWtqQg%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODg6d3VRMA%3D%3D) |
| triage / live / clairic | [RXhwZXJpbWVudDo2OTA6aWdKSw==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjg6dWtTQg%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTA6aWdKSw%3D%3D) |
| injection / live / jev-1.14.0___jev-1.14.0 | [RXhwZXJpbWVudDo2OTE6aWozcA==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjk6KzhNbA%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTE6aWozcA%3D%3D) |
| triage / live / jev-1.14.0___clairic | [RXhwZXJpbWVudDo2OTI6YXgvQQ==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzU6bGlqMQ%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTI6YXgvQQ%3D%3D) |
| feedback / offline / server_feedback | [RXhwZXJpbWVudDo2ODk6cHBVaQ==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzQ6Wk54Yw%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2ODk6cHBVaQ%3D%3D) |
| agent / live / claude-code_claude-opus-5-5 | [RXhwZXJpbWVudDo2OTM6TVpTRw==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzY6VllNZQ%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTM6TVpTRw%3D%3D) |
| agent / live / codex_gpt-6.1-sol | [RXhwZXJpbWVudDo2OTU6K1J0NA==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5MzY6VllNZQ%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTU6K1J0NA%3D%3D) |
| triage / live / parser_regex | [RXhwZXJpbWVudDo2OTQ6VnROcw==](https://app.ca-central-1a.arize.com/organizations/QWNjb3VudE9yZ2FuaXphdGlvbjoxNjk6NjNYcQ%3D%3D/spaces/U3BhY2U6MjE5OkI1UjA%3D/datasets/RGF0YXNldDo5Mjg6dWtTQg%3D%3D/experiments/compare?experimentId=RXhwZXJpbWVudDo2OTQ6VnROcw%3D%3D) |

Experiment names contain suite, identity, execution git SHA and run ID. Corpora are exact selected case sets per identity. Names and raw IDs are also retained in each results JSON.

## Verification and scope

- `bun test apps/evals`: **20 pass, 0 fail** after final formatting; fake AX and fake OTLP transports, no network in tests.
- Package typecheck: **pass**.
- The single whole-repository `bun run typecheck && bun test`: all workspace typechecks passed; **336 pass, 2 fail**. New eval source formatting caused one failure; corrected and the focused style guard now passes.
- Remaining unrelated failure: `apps/web/test/legal.test.ts:113` pricing rounding property. Exact counterexample `[1,1,1,6,5]` gives shown `0` versus exact `1.1e-9`. Source and test blob hashes match base `f1fa1ae`; left unchanged. The full suite was not rerun, honoring the resource rule.
- No core changes. Only the additive boundary entry, new eval app, and the scoped server failed-turn fix are outside generated/ignored run data. `bun.lock` was already modified when this lane started and remains unstaged.

## Commits

Implementation history (all trailers identify gpt-6-astra):

- `c77966b` Add versioned evaluation suites, scoring and Arize export
- `7779f9f` Reject unsuccessful agent turns before publishing or advancing
- `33f725a` Evaluate the combined Clairic and Jev triage pipeline explicitly
- `c4064d7` Retain redacted CLI diagnostics for unavailable agent runs
- `a49836a` Bound fixture commands with process-group deadlines
- `8d8a319` Distinguish observed agent contract failures from unavailable runs
- `cae667d` Attach regional Arize dataset and experiment deep links
- `bac9895` Test unavailable versus observed agent failure classification
- `23e054a` Format evaluation sources to repository readability limits

This baseline is committed in the following documentation-only commit. Exact run files remain under `apps/evals/results/`; no credentials are included.
