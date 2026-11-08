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

`ProofOptions.collectEvidence(context)` runs after the core proof observations and before policy evaluation,
while both exact, prepared worktrees still exist. It receives `baseCwd`, `headCwd`, the observed core items,
and a shared `remainingMs()` deadline. Additional items must pass the core schema, remain bounded and cannot
replace repro, test or diff observations. An absent collector contributes no evidence. An unavailable
collector stops proof and still cleans up both worktrees; no missing integration becomes a passing item.

The server's verification collector executes selected intent and registered regression probes, invokes a
configured real reviewer, and runs configured UI/replay report commands at the prepared head. A new repair's
actual repro script is executed again to seed regression coverage when there are no closed trails yet.
External persona, respondent and approval evidence requires a host-authorized source receipt bound to the
exact trail, revision, base and head. Merely returning an evidence-shaped model answer is insufficient.
Offline tests exercise these boundaries and actual local Git registry persistence; live provider studies,
browser report integrations and hosted execution remain Unverified until those integrations run.

## Live run events (`run-events.ts`)

`claudeStreamNormalizer` (Amp `--stream-json` and Claude Code `--output-format stream-json --verbose`, which share a format) and `codexNormalizer` (`codex exec --json`) turn an engine's output, line by line, into the console's `AgentRunEvent` (without `runId`, `seq` and `at`, which the server stamps): `message`, `reasoning`, paired `tool_call` / `tool_result`, `status` and `portal`. Everything is redacted (`redact.ts`, which now also covers JSON-quoted keys and well-known token shapes) and cut to the schema limits. A line that is not JSON, or an event type the normalizer does not know, yields nothing; the user turn that carries the prompt is never echoed (it holds quoted signal text). A `portal` event is emitted only when a command that asks for a portal (`amp orb portal …`, `--portal`) printed an `https://` URL.

Agents report events through an optional fourth argument to `run` (`AgentRunOptions`: `onEvent`, `onExecutor`, `secrets`); `CodingAgent` and `AgentResult` in core are unchanged, and an agent run without options behaves as before (Claude Code then still uses `--output-format json`). `AmpAgent.executor()` says where turns run (`orb` with project, `runner` with its id, or `local`) and reports the thread URL (`https://ampcode.com/threads/<id>`) through `onExecutor` once the stream names the thread. `runAgent` and `executorOf` are the helpers the server uses.

Verified offline: the real `amp-error-reauth.jsonl` capture, plus hand-written `amp-success-stream.jsonl` and `codex-events.jsonl` fixtures, chunk-split feeding, truncation and redaction properties, and Amp, Claude Code and Codex agents over a fake runner. **Unverified:** the success-path stream fixtures follow the documented Claude Code and Codex event shapes but are not captures from a live run; Claude Code's `stream-json --verbose` flags and Codex's `item.*` event details, the portal URL appearing in an `amp orb portal` tool result, and the Ephyra plugin's policy decisions (see the server README) have not been seen live.

## Sharing a visual during a run

The prompt now explains a portable publication envelope, usable through ordinary shell tools in local CLIs or remote orbs.
An agent writes a self-contained HTML file and prints a single line from a successful command:

```python
import json
from pathlib import Path
print('EPHYRA_VISUAL ' + json.dumps(dict(
    id='review', title='Inspect the change', html=Path('review.html').read_text(), height=420,
)))
```

An assistant may instead include the same JSON in an `ephyra-visual` fenced block, except in a JSON-only review response.
This is a stream protocol, not an installed MCP tool. Amp/Claude and Codex normalizers validate and redact the content
before emitting an event with `visual`. It is captured before ordinary tool-log truncation. Failed/unpaired tool outputs,
user messages, malformed envelopes, and oversized content cannot publish a visual. HTML is limited to 240,000 characters,
serialized presentations to 256,000, and accepted source envelopes to two million characters per normalizer instance.
The stable ID identifies revisions; the console keeps the opened version until the viewer loads an update.

Pages can use inline scripts/styles and data-URI images or animation. External resource requests and host APIs are blocked
by the console's isolated frame. The prompt asks for available browser verification; the envelope itself never asserts that
a browser check or proof ran. Saved pages remain in run history after the execution environment ends.

Portal detection also recognizes `amp orb services ensure` and preserves multiple returned links. Links with embedded
credentials or supplied secret values are discarded. These are recorded addresses, not health checks; failed command output
does not advertise a working preview. Amp URLs must come from actual command output, per the
[portal contract](https://ampcode.com/docs/orbs/portals).

Verified: synthetic stream chunks through the real recorder, authenticated HTTP/SSE and Chromium, including live arrival,
interaction, revision/reload behavior and host isolation. Unverified: a live model choosing the protocol, live Amp orb access,
portal authentication/lifetime and deployed Convex storage. No provider calls are made by these checks.
