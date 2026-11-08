# Agent

Renders step-specific prompts with untrusted blocks, runs Claude Code or Codex through an injected Runner, records reported usage and observes Entire trailers. Review JSON is validated before becoming a proof item. ProofBuilder runs a shared probe and test suite in detached worktrees, measures the diff and delegates policy evaluation. UI evidence is present only for configured commands that ran. Proof logs are bounded and redact common credential formats and explicitly supplied secrets; callers must supply any known secret values.

Offline tests cover prompt escaping, CLI invocation and timeout reporting, malformed review, a real temporary git repository with a failing-then-passing probe and Bun tests, and an observed Entire trailer. No live model, provider, Storybook or Textbook integration has been verified. Runner implementations must enforce `deadlineMs` and report timeouts. Neither installed CLI advertises a hard token cap or a max-turns option, so these adapters cannot enforce either limit; usage is reported after execution. Codex does not report cost in its JSON events, so cost is null.

`ProofOptions.prepareRevision({ cwd, commit, remainingMs })` runs once in each fresh base/head
worktree before its probes or tests. It can install the revision's dependencies and return
`PreparedProofRevision` with a `testCommand` argv and a preparation `log`. The command must match
between revisions; the redacted preparation log accompanies the test evidence. Failed preparation
stops proof evaluation and still attempts worktree cleanup. The caller supplies dependency identity,
installation receipts and replay protection; a successful setup sandbox does not prepare another VM.

The exported `parseTestOutput(output, exit, secrets?)` reads Bun, Cargo, Node TAP v13, Jest and Vitest
text reports. Counts must agree with the process exit and every failed test needs a distinct observed
identity. Unknown formats, incomplete or mixed summaries, cancellations, empty/skipped-only suites
and ambiguous failure identities throw `Unverified`. Offline parser tests include actual local
`node:test` output and recorded-format Jest/Vitest fixtures. These fixtures verify parsing, not live
Jest/Vitest installation or hosted execution; arbitrary custom reporters remain unsupported.

Proof probes run three times at each revision by default (`probeRuns` accepts integers from 2 to 10).
Every base run must fail and every head run must pass. A disagreement throws `Unverified` before
policy evaluation; successful bundles retain redacted output and exit status for every attempt.
Repeats share their revision's worktree, so probes must tolerate repeated execution. Repetition catches
observed instability, not every possible flake, and does not rerun the entire test suite.

## Live run events (`run-events.ts`)

`claudeStreamNormalizer` (Amp `--stream-json` and Claude Code `--output-format stream-json --verbose`, which share a format) and `codexNormalizer` (`codex exec --json`) turn an engine's output, line by line, into the console's `AgentRunEvent` (without `runId`, `seq` and `at`, which the server stamps): `message`, `reasoning`, paired `tool_call` / `tool_result`, `status` and `portal`. Everything is redacted (`redact.ts`, which now also covers JSON-quoted keys and well-known token shapes) and cut to the schema limits. A line that is not JSON, or an event type the normalizer does not know, yields nothing; the user turn that carries the prompt is never echoed (it holds quoted signal text). A `portal` event is emitted only when a command that asks for a portal (`amp orb portal …`, `--portal`) printed an `https://` URL.

Agents report events through an optional fourth argument to `run` (`AgentRunOptions`: `onEvent`, `onExecutor`, `secrets`); `CodingAgent` and `AgentResult` in core are unchanged, and an agent run without options behaves as before (Claude Code then still uses `--output-format json`). `AmpAgent.executor()` says where turns run (`orb` with project, `runner` with its id, or `local`) and reports the thread URL (`https://ampcode.com/threads/<id>`) through `onExecutor` once the stream names the thread. `runAgent` and `executorOf` are the helpers the server uses.

Verified offline: the real `amp-error-reauth.jsonl` capture, plus hand-written `amp-success-stream.jsonl` and `codex-events.jsonl` fixtures, chunk-split feeding, truncation and redaction properties, and Amp, Claude Code and Codex agents over a fake runner. **Unverified:** the success-path stream fixtures follow the documented Claude Code and Codex event shapes but are not captures from a live run; Claude Code's `stream-json --verbose` flags and Codex's `item.*` event details, the portal URL appearing in an `amp orb portal` tool result, and the Ephyra plugin's policy decisions (see the server README) have not been seen live.
