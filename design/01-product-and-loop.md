# Ephyra — 01: Product and the self-driving loop

Companion to `02-platform.md` (forge adapters, git ref layout, Railway topology, workflow engine, sandboxes, provider registry, security). This document owns *what the loop does*; wherever it says "ref layout", "sandbox" or "forge object", the platform doc is authoritative for the mechanism.

## 1. Thesis

A **self-driving application** is a running system that owns its own defect loop: it senses that something is wrong (production errors, probe failures, drift from declared intent), gathers evidence, reproduces, patches, proves the patch, lands it, and watches the result — pausing for a human exactly where policy says it must. The unit of work is a **trail**, not a PR. PRs are a GitHub artefact that forces every change through one review shape and one host; a trail is a durable, resumable record stored in git (and mirrored to Radicle COBs or Tangled records when useful) whose *landing* can be a branch, a patch, a pull, or a live change applied into a devenv for a human to try.

**Jellyware** changes the risk calculus: the cost of a bug is severity × time-in-production, so for the loose edges of a system it is cheaper to land fast, watch closely and roll back automatically than to gate on review. Humans harden the core (schemas, auth, money, intents) and set blast-radius policy; the edges self-drive.

## 2. Trail lifecycle

### 2.1 States

| State | Meaning |
|---|---|
| `sensed` | One or more signals attached; no decision yet |
| `triaged` | System One tier assigned severity, route, dedupe result |
| `researching` | Evidence gathering in progress |
| `hypothesised` | `hypothesis.md` written; **checkpoint A** |
| `reproducing` | Building a failing probe in a sandbox |
| `planned` | `plan.md` written; **checkpoint B** |
| `patching` | Implementing in sandbox worktree |
| `proving` | Assembling proof bundle |
| `ready` | Proof passes policy; **checkpoint C** (landing decision) |
| `landing` | Pushing ref / creating forge object / applying to devenv |
| `watching` | Post-landing watch window open |
| `closed` | Success; trail becomes a regression probe |
| `rolled_back` | Watch failed; revert landed; new revision opened |
| `parked` | Paused (human, missing info, budget, base moved too far) |
| `handed_off` | Human claimed the trail; agent stopped |
| `abandoned` | Killed; reason recorded |

### 2.2 Transitions

```
sensed ──triage──▶ triaged ──┬─ route=auto_fix|research ──▶ researching
                             ├─ route=human ───────────────▶ parked (inbox: "needs a human")
                             ├─ duplicate_of=T ────────────▶ (signal merged into T; no trail)
                             └─ route=ignore ──────────────▶ abandoned

researching ──▶ hypothesised ──[A]──▶ reproducing ──▶ planned ──[B]──▶ patching ──▶ proving
proving ──pass──▶ ready ──[C]──▶ landing ──▶ watching ──window clean──▶ closed
proving ──fail(n<max)──▶ patching          watching ──rollback criteria──▶ rolled_back ──▶ researching (rev+1)
reproducing ──cannot repro──▶ parked       landing ──base moved──▶ patching (rebase)
any ──human: pause──▶ parked ──human: resume──▶ (previous state)
any ──human: claim──▶ handed_off           any ──human: kill──▶ abandoned
```

Checkpoints A/B/C are the HumanLayer-style alignment points. Whether each is *blocking* (waits for a human) or *advisory* (recorded, continues) is decided per code area by the autonomy policy (§7). `research_only` routes stop after A and post the hypothesis to the inbox. A fourth decision kind, **spend**, gates money outside the model budget — today only voxq respondents (§7).

### 2.3 Durable record

A trail is a directory committed to its journal ref, `refs/ephyra/trails/<id>/journal`, with immutable patch tips and proof manifests under `…/<id>/revisions/NNNN` and `…/<id>/proofs/NNNN` (02-platform §2 is authoritative). Contents:

```
trail.json              # typed header, below
events/<event-id>.json  # one file per event (no append conflicts)
signals/*.json          # attached Signal objects
triage/*.json           # extraction + judgement request/response per signal, with backend identity
evidence/*              # retrieved artefacts + evidence/index.json
hypothesis.md  plan.md
patch/                  # diffstat + base sha; commits live on the trail's worktree branch
proof/manifest.json     # §8, plus the screenshots, frames and tapes it cites
watch.json              # post-landing watch config + outcome
```

```ts
type Trail = {
  id: string;                        // UUIDv7 (time-sortable); shown as short form "T-xxxx"
  rev: number;                       // bumped on rollback/retry
  state: TrailState;
  signals: SignalId[];
  area: string;                      // autonomy-policy area name (§7)
  risk: 'low' | 'medium' | 'high' | 'critical';
  route: 'auto_fix' | 'research_only' | 'human';
  base: { ref: string; sha: string };
  landing?: { mode: LandingMode; target: string; sha?: string };
  owner?: { kind: 'agent' | 'human'; id: string };
  checkpoints: { A?: Decision; B?: Decision; C?: Decision; spend?: Decision[] };
  budget: { tokens_used: number; tokens_max: number; wallclock_max_s: number;
            spend_microusd_used: number; spend_microusd_max: number };   // money outside model calls
  mirrors?: { radicle_cob?: string; tangled_uri?: string; sapling_stack?: string };
};
type Decision = { by: 'policy' | 'human'; who?: string; at: string; verdict: 'approve' | 'revise' | 'reject';
                  note?: string; shadow?: boolean; backend?: string /* e.g. "judgement-jev/jev-1.14" */ };
```

Pause/resume is a property of the record, not the process. The hot path is the DBOS workflow plus `trail_projection` in Postgres; the git journal is the durable, portable copy, published through an outbox, so a transition counts as durable only after git acknowledges it (02-platform §3). A still-running agent receives new events in place (Murmur's behaviour); a restarted one rebuilds its context from the journal.

## 3. Sensing

Everything enters as a **Signal**:

```ts
type Signal = {
  id: string; kind: 'prod_error' | 'trace_anomaly' | 'log_anomaly' | 'probe_failed'
                  | 'regression_failed' | 'user_report' | 'forge_event' | 'hunt_finding';
  observed_at: string; service: string; env: 'prod' | 'staging' | 'sandbox';
  deploy: { sha: string; devenv_profile?: string };
  trace_id?: string;                 // W3C traceparent; devenv propagates TRACEPARENT
  fingerprint: string;               // code-computed: kind + normalised top frame / probe id / route / story id
  payload: unknown;                  // raw: exception, span set, log window, report text, event
  source: { system: string; ref: string };
};
```

| Source | How it arrives | Notes |
|---|---|---|
| **Production** | OTel collector → error spans, exception events, log anomalies (rate/novelty vs baseline per `service+route`) | Code-level fingerprint dedupe first; only *new or re-rising* fingerprints go to triage. |
| **Active hunting** | Scheduled **hunters** run in sandboxes (service profile: read-only) and emit `hunt_finding` | Property tests over typed boundaries; fuzzers on parsers; **prod traffic replay** (sampled, PII-scrubbed requests replayed against a sandbox at the candidate sha, diffing status/latency/shape); **agent exploratory testing** (budgeted LLM drives UI/API, files findings with recordings); **tracer bullets** (`ephyra.tracer("would_reject", …)` where code *would* reject but doesn't yet; hunters cluster them); **turn the vise** (tighten a tracer bullet into a rejection in a sandbox, replay traffic); **story render** (every Storybook and Textbook story rendered on each default-branch push and on a schedule; render failures, failed interaction tests and visual drift from the approved baseline are findings, which catches dependency bumps). |
| **Past issues** | Every `closed` trail contributes its repro as a **regression probe**, run on every landing that touches the trail's files and nightly; failure → `regression_failed` | Also `entire search` across sessions/checkpoints when a new signal's files match a past trail ("we touched this before, here's why"). |
| **Intent** | Probes defined in `intents/*.md` (§4); failure → `probe_failed` | The only source that can say "nothing crashed, but the app no longer does what it's for". |

Hunter definitions live in `ephyra/hunters/*.yaml`:

```yaml
name: stories
kind: story_render              # property | fuzz | traffic_replay | agent_explore | tracer_cluster | vise | story_render
on: [default_branch_push, schedule: "every 6h"]
surfaces:
  web:      { tool: storybook, config: webapp/.storybook }                        # render, play tests, screenshots
  terminal: { tool: textbook, pattern: "src/**/*.stories.ts", viewport: "80x24" } # render, tape replay, frames
baseline: last_approved
budget: { minutes: 15 }
```

## 4. Intent

Intents are plain-English statements a human writes, each with machine-checkable probes. One file per intent in `intents/`:

```markdown
---
id: checkout-completes
area: payments
severity: high            # what a confirmed drift is worth
probes:
  - kind: http
    every: 5m
    request: { method: POST, url: "{{base}}/api/checkout", body_file: fixtures/cart-small.json }
    expect: { status: 200, json: { "$.order_id": { matches: "^ord_" } }, p95_ms: 800 }
  - kind: trace
    every: 15m
    query: 'span.name = "checkout.complete" AND status = ERROR'
    expect: { rate_lt: 0.5%, window: 1h }
  - kind: script
    every: 1h
    run: "devenv shell -- pnpm probe:checkout-email"   # exits non-zero on failure
  - kind: story                                         # UI intent; no live environment needed
    every: 1h
    surface: web                                        # web (Storybook) | terminal (Textbook)
    story: "Checkout/PaymentForm"
    play: submit-valid-card                             # or, for terminal: tape: fixtures/pay.tape.json
    expect: { passed: true, visual: unchanged_since_approved }
  - kind: agent
    every: 24h
    sample: 0.1
    instructions: "Buy one item as a new user. Confirm you reach a page stating the order number."
  - kind: voxq                                          # periodic intent check with real people (§7)
    every: 30d
    study: studies/checkout-clarity.json                # first_click | preference | chat_task | survey
    simulate_first: true                                # persona run first; labelled synthetic
    respondents: { n: 30, via: prolific, max_spend_usd: 45 }   # via: share_link | embed | prolific
    expect: { "$.first_click.hit_rate": { gte: 0.7 } }
---
A signed-in or guest user can complete checkout for an in-stock item with a valid card
and receives an order number on screen and by email within one minute.
```

**Running.** `http`/`trace`/`script`/`story` probes are cheap and scheduled (`story` renders at the deployed sha inside devenv). `agent` probes are LLM-driven, sampled, and run only from a service profile with explicit write permission to staging or a sandbox, never prod by default. Each real-respondent `voxq` run waits for a spend approval (§7). Results are a time series per `(intent, probe)`.

**Drift detection.** A single failure is a `probe_failed` signal and goes through triage like anything else. *Drift* is the sustained version: `drift = severity_weight × (1 − pass_rate_24h / pass_rate_baseline_14d) × persistence`, where `persistence` is the fraction of the last 6 windows that failed. Drift above 0.3 opens a trail even if no single failure was actionable. The decision backend is asked, with the intent text and recent results as state, whether this looks like *intent drift*, *flaky probe*, or *intentional change* (choice) — the last routes to a human with "update the intent or revert?".

## 5. Triage with the System One tier

Triage is two cheap calls plus code. No LLM runs until a trail is routed. The request shapes are Not Organic's `/v1/extraction` and `/v1/judgement` contracts, which the user's other applications already speak; Ephyra sends the same shapes to whichever backend the user chose.

**Which models answer is the user's choice.** The provider registry (02-platform §5) binds `extract` and `decide` to one of:

| Mode | Extraction | Decision |
|---|---|---|
| **Hosted** (Not Organic) | `extraction` → Clairic | `judgement` (Jev by default), or explicit `judgement-jev` / `-luna` (gpt-6-luna) / `-pplx` (pplx-decider) / `-vision` |
| **BYOK** | Workers AI `@cf/cloudflare/clairic`, or any endpoint speaking the contract | TypeSafe, a Runpod `/v1/systemone`, or any endpoint speaking the contract |
| **Self-hosted** | Deterministic stack-trace and log parsers (spans, no `confidence`) until Clairic weights ship | Liquid AI **d1** (`d1-omni-2B` recommended; `d1-2B`, `d1-omni-600M`; LFM Open License) or **Clef** (Apache-2.0) behind Ephyra's `decide` adapter |

Hosted calls are paid from the account wallet, reserve-then-settle, with `Idempotency-Key` = trail id + signal id + question set, so retries never double-bill. A self-hosted entry declares which question types it serves; unserved types take the conservative branch of the policy table. Every `triage/` record stores the response `model` identity (`extraction-clairic/<upstream>`, `judgement-jev/jev-1.14`, `local/d1-omni-2B@sha256:…`). **Thresholds are keyed by that identity** in `ephyra/thresholds.yaml`; a reported `fallback: {from, to, reason}` switches to the `to` identity's thresholds, and an unknown identity routes `research_only` and asks the inbox to calibrate. Ephyra never sends `allow_fallback: true` unless the operator enabled it.

**Step 1 — extract.** State is the raw payload text; fields are typed (`text | number | date | time | datetime | duration | list | estimate | forecast`).

```json
POST https://api.notorganic.info/v1/extraction     // extraction:run; or a BYOK/self-hosted endpoint with this shape
{
  "model": "extraction",
  "state": "<stack trace, log window or user report; ≤ 8k tokens>",
  "reference_date": "2026-11-06",
  "fields": {
    "exception_type": { "type": "text",   "instructions": "Exception or error class name" },
    "top_app_frame":  { "type": "text",   "instructions": "First stack frame in application code, not a dependency: path:line" },
    "affected_count": { "type": "number", "integer": true, "instructions": "Users or requests affected, if stated" },
    "touched_files":  { "type": "list",   "items": "text", "instructions": "Application source files mentioned" }
  }
}
```

Response: `{ model: "extraction-clairic/<upstream>", answers: { <field>: { type, value, guess?, p_null, confidence, span | spans } }, truncated, usage }`. `value` is `null` when the input does not determine it, `guess` keeps the near miss, and text answers are `[start, end)` spans into the state, so the evidence index can cite offsets. A null `top_app_frame` with `p_null > 0.8` means "not our code" and routes to `ignore` unless a probe or user report says otherwise; `truncated: true` re-runs on the payload's tail.

**Step 2 — decide.** State is a map of strings (each value serialised JSON): the extracted fields, the excerpt, and *candidates* retrieved by code (top-5 open/recent trails by fingerprint distance and shared files; in-flight trails touching the same files; recently closed trails in the area). The model cannot pick a candidate it is not shown, so retrieval coverage matters more than prompt wording. Three of six questions are shown: `regression_of` and `conflicts_with` are `choice` questions like `duplicate_of` over `recently_closed` and `in_flight_same_files`; `severity` is a four-rung `score` from "cosmetic or log noise" to "core flow broken or security-relevant".

```json
POST https://api.notorganic.info/v1/judgement      // judgement:evaluate
{
  "model": "judgement",                            // or judgement-jev | -luna | -pplx | -vision, or a registry alias
  "allow_fallback": false,
  "state": { "signal": "<JSON>", "open_trails": "<JSON: [{id:'T-01J9…', title:'NPE in cart total when coupon expired', …}]>",
             "in_flight_same_files": "<JSON>", "recently_closed": "<JSON>", "policy": "<JSON: {area:'cart', auto_fix_allowed:true}>" },
  "questions": {
    "actionable": { "type": "noul",
      "instructions": "Is the failure in `signal` caused by this application's own code or configuration, rather than a third-party outage, client bug or user error?",
      "criteria": { "true": "Our code or config", "false": "Outage, client bug or user error" } },
    "duplicate_of": { "type": "choice",
      "instructions": "Which entry in `open_trails` has the same root cause as `signal`? Choose none if no entry matches.",
      "criteria": { "T-01J9…": "NPE in cart total when coupon expired", "none": "No open trail shares this root cause" } },
    "route": { "type": "choice",
      "instructions": "Given `signal` and `policy`, what should happen next?",
      "criteria": { "auto_fix": "Cause is clear enough to research, reproduce and patch without a human first",
                    "research_only": "Worth investigating and reporting; a human decides on any change",
                    "human": "Needs a person now: ambiguous, product decision, or policy forbids automation here",
                    "ignore": "Noise, expected, or not this application's problem" } }
  }
}
```

Response (verbatim contract): `model: "judgement-jev/jev-1.14"`; `answers.actionable = {type:"noul", noul: 0.93}`; `answers.duplicate_of = {type:"choice", choice:"none", confidence:0.81, probabilities:{…}}`; `answers.severity = {type:"score", score: 2.3, confidence: 0.6, legend:{…}, probabilities:{…}}`; optional `fallback`. Code applies that identity's thresholds (defaults below, evaluated on the project's own data, not hard-coded truths):

| Condition | Action |
|---|---|
| `duplicate_of ≠ none` and its probability ≥ 0.7 | Merge signal into that trail; emit `new_signal` event to it |
| `regression_of ≠ none` ≥ 0.7 | Reopen that trail at `rev+1`, state `researching`, severity floor = original |
| `conflicts_with ≠ none` ≥ 0.6 | Create trail with `parent = that trail`; it starts after the parent lands (PostHog's duplicate-PR fix, done structurally) |
| `actionable < 0.4` or `route = ignore` ≥ 0.8 | `abandoned` with reason; fingerprint muted for 24h |
| `severity ≥ 2.5` | Force `route = human` notification *in addition to* the picked route |
| `duplicate_of` or `route` confidence < 0.5, or unknown backend identity | Create trail as `research_only` (cheap, safe default) |

**Illustrative cost per 10,000 raw signals.** Hosted and BYOK use published list prices (Not Organic passes Jev's through; luna and pplx are operator-priced). The d1 timing is **Liquid's self-reported figure** (8 ms per question, d1-3B on an RTX 4090), not measured here.

| Stage | Volume × tokens | Hosted (Not Organic wallet) | BYOK | Self-hosted |
|---|---|---|---|---|
| Fingerprint dedupe | 10,000 → ~1,500 unique | $0 | $0 | $0 |
| Extraction | 1,500 × ~2,000 | Clairic $0.10/M input → **$0.30** | Workers AI direct → **$0.30** | Parsers → $0 (Clairic weights unpublished) |
| Decision (6 questions) | 1,500 × ~3,000 | Jev $0.042/M input, output free → **$0.19** | TypeSafe direct → **$0.19** | d1-omni-2B or Clef: ~9,000 questions ≈ 72 s of one consumer GPU → ≈ $0 |
| **System One total** | | **≈ $0.49** (≈ $3.30 if all 10k unique) | **≈ $0.49** | **≈ $0 + hardware** |
| LLM agent trails | ~2% routed → 30 | $1–5 each → $30–150 | same | depends on the local model |

Listening to everything is nearly free in every column, so the gate on spend is the *route*, and the route is a calibrated probability you tune per backend.

## 6. Evidence gathering

Once routed, the researching agent fills `evidence/index.json` from these tools, each returning citations the proof bundle can reference:

| Tool | Query | Returns |
|---|---|---|
| `entire search` | fingerprint text, file paths, `--all-repos` | Past sessions/checkpoints/commits that touched the area; `entire blame` for *why* a line exists |
| Past trails | area, files, fingerprint distance | Hypotheses, repros and proofs from earlier trails, including rolled-back ones ("we tried X, it failed because Y") |
| Traces/logs | `trace_id`, route, window | Span tree, attributes, related errors; sampled requests for replay |
| Code graph | symbol, file | Callers/callees, owners, test coverage for the frame |
| Forge | file paths | Open patches/pulls/issues touching the same files |
| Stories | components in the touched files | Storybook/Textbook renders at `base.sha` (the "before" for the visual diff); components with no story |
| **voxq** (`voxq mcp` / REST) | a study the agent writes: `create_survey` → `run_survey` against saved audience personas → `get_results` / `get_analysis` by `run_id` | `voxq_run` citations with the frozen study snapshot and run id. Persona runs are **hypotheses**, stored `synthetic: true`; they never satisfy a proof. The same instrument with real people is proof (§8), after a spend approval (§7). |

`Evidence = { id, tool, query, summary, synthetic?, cite: { kind: 'commit' | 'checkpoint' | 'trace' | 'log' | 'file' | 'trail' | 'url' | 'story' | 'voxq_run', ref, span? }, retrieved_at }`.

## 7. Research → plan → implement, with humans in the loop

**What the human sees** is an **inbox** of checkpoints, not diffs-first. Each item is one trail at a checkpoint: one-line title, severity, area, autonomy mode, then the artefact for that checkpoint (`hypothesis.md`, `plan.md`, proof summary + diffstat, or a spend request). The inbox is an OpenTUI application with its own Textbook stories. Keyboard-driven (Superhuman/CodeLayer style):

| Key | Action | Trail event |
|---|---|---|
| `j`/`k` | next/prev | — |
| `a` | approve checkpoint or spend | `checkpoint_decided{approve}` / `spend_decided{approve}` |
| `r` | request revision (opens a one-line note) | `checkpoint_decided{revise, note}` |
| `x` | reject / kill | `killed` |
| `c` | comment (multiplayer) | `human_comment` |
| `t` | take over (claim) | `claimed_by_human` |
| `p` | park / resume | `parked` / `resumed` |
| `o` | open the landing (portal to the devenv, patch, pull, Canvas, or the stack in ISL) | — |
| `l` | land now (when `ready`) | `land_requested` |
| `e` | explain: show the evidence index for this item | — |

**Sapling as a human surface (optional).** With Sapling on the repo's git store, `ephyra sl sync` shows the trail's worktree commits as a **draft stack** titled `T-xxxx: <title>` in the smartlog and ISL, next to the human's own stacks (`mirrors.sapling_stack`); `o` opens it in ISL. Accepting (`a` then `l`, or ISL's land button through the same hook) lands it via the trail's landing mode and the stack turns public. Taking over is `sl goto <top>` + `sl amend`: the next sync reads the mutation record (new commit replaces old), emits `human_revision`, stops the agent, sets `handed_off` and makes the amended stack the trail's head. `sl hide` is `x`. Nothing here is required: plain git (`git fetch refs/ephyra/trails/<id>/*`, `ephyra claim`) does the same with less convenience.

**Autonomy policy** is a plain-English file, `ephyra/autonomy.md`, read by both humans and the policy step. Areas are named and bound to globs; each states what the loop may do unattended. Forge-agnostic analogue of `.macroscope/approvability.md`:

```markdown
# Autonomy policy

## defaults
mode: shadow                  # shadow | enforce
checkpoints: A=advisory B=advisory C=blocking
landing: trail_ref
watch: 2h
decide: judgement             # registry alias; thresholds follow the identity the response reports

## area: payments
paths: src/payments/**, src/checkout/**, intents/checkout-*.md
risk: critical
ui: webapp/src/checkout/**    # changes here need story proof (§8)
user_facing: true
Nothing lands here without a named human approving C. Patches must come with a
traffic-replay proof. Never touch schemas. Copy or flow changes need a real-respondent
voxq test before C; persona runs alone never count.

## area: cart
paths: src/cart/**
risk: medium
Agents may reproduce and patch. B is advisory; C is blocking unless the change is
under 40 lines, touches no exported types, and the regression probes pass — then
auto-land as trail_ref + devenv_live and watch for 2h.

## area: marketing-site
paths: apps/site/**
risk: low
ui: apps/site/src/**
user_facing: true
voxq_budget_usd: 60/month     # pre-approved by @diogenes for scheduled voxq probes
Loose edge. Auto-land to main with a 1h watch. Roll back on any new error fingerprint.
Copy changes carry a persona study; ask real people only about the signup path.
```

The prose is the policy; the key/value lines are what code reads directly. The prose is evaluated by one `choice` question per checkpoint on the configured decision backend ("Under the text of this area's policy, may the loop proceed past this checkpoint without a human?" with the policy text and trail header as state) and recorded as `Decision{by:'policy', backend}`. **Shadow mode**: in `shadow`, every policy decision is computed and written with `shadow: true`, but the trail still waits for a human. The inbox shows "would have auto-approved" badges; after a week, a report of would-approve vs human verdicts tells you whether to flip the area to `enforce`.

**Human-intent evidence (voxq).** For changes to what users see or are asked to do — copy, onboarding, pricing pages, the order of a flow — the agent can run a voxq study: a persona simulation first (cents of inference; a hypothesis), then optionally the same instrument with real people (first-click, preference or chat task; share link, embed or Prolific, where the panel owns payment). voxq's rule is Ephyra's: **synthetic agreement is never proof**; it only decides what to ask people and what to expect. Real respondents cost money and strangers' time, so each human run waits for `spend_decided{approve}` from a named human ("30 respondents via Prolific, ≤ $45, for T-xxxx"), unless it fits an area's `voxq_budget_usd`, which a named human signed in `autonomy.md`. Per `user_facing` area (others use neither):

| Risk | Persona simulation | Real respondents |
|---|---|---|
| low | allowed at the agent's discretion (e.g. to pick between two copy variants) | not allowed |
| medium | required in evidence for copy and flow changes | allowed after spend approval; required when the cited intent has a `voxq` probe |
| high / critical | required | required before C; a bundle with only synthetic results is not `passed` |

## 8. Proof bundles, landing, and the post-landing watch

### 8.1 Proof bundle

```ts
type ProofBundle = { items: ProofItem[]; risk: Risk; passed: boolean; computed_at: string };
type ProofItem =
  | { kind: 'repro_before'; probe: string; result: 'fail'; log: string }    // the bug is real at base
  | { kind: 'repro_after';  probe: string; result: 'pass'; log: string }    // and gone at head
  | { kind: 'tests';        suite: string; passed: number; failed: number; log: string }
  | { kind: 'regression_probes'; ran: string[]; failed: string[] }
  | { kind: 'intent_probes'; ran: string[]; failed: string[] }
  | { kind: 'traffic_replay'; hunter: string; diffs: number; report: string }
  | { kind: 'trace';        trace_id: string; note: string }
  | { kind: 'bug_review';   findings: { severity: Risk; text: string }[] }  // independent reviewer agent
  | { kind: 'diff_scope';   files: number; lines: number; exported_types_changed: boolean }
  // UI: Storybook (web) and Textbook (terminal); surface: 'web' | 'terminal'
  | { kind: 'story_render';      surface; stories: string[]; failed: string[]; uncovered: string[] }
  | { kind: 'story_interaction'; surface; stories: string[]; failed: string[]; log: string }   // play tests / tape replays
  | { kind: 'story_visual_diff'; surface; baseline_sha: string; changed: string[]; explained: string[]; artefacts: string }
  | { kind: 'recording';          path: string; what: string }                  // web: browser video of the changed flow
  | { kind: 'terminal_recording'; story: string; tape: string; what: string }   // Textbook JSON tape (timestamps, ANSI frames, size) or VHS gif
  // people
  | { kind: 'voxq_study'; study: string; run_id: string; respondents: number; via: 'share_link' | 'embed' | 'prolific';
      synthetic_run_id?: string; spend_microusd: number; expect_met: boolean; report: string };
```

**UI proof.** A trail touches UI when its diff matches an area's `ui:` globs. Web UI is proven with **Storybook**: stories, play-function interaction tests, and per-story screenshots at fixed viewports diffed locally. Terminal UI is proven with **Textbook**: `*.stories.ts` for OpenTUI components, tapes of keystrokes and ANSI frames replayed into the story, frame diffs at a viewport preset (80×24 default), and Canvas for a human to drive the story through a portal. Both run inside devenv. `story_render.uncovered` lists components in the diff with no story and must be empty to reach `ready`: **a UI change without a story first adds the story**, as a bug fix first adds a repro. `story_visual_diff` compares against `base.sha`; a changed snapshot is `explained` when `plan.md` declares it, otherwise the proof fails, and a human approves visual changes above `low`. `voxq_study` is only ever a real-respondent run; `synthetic_run_id` links the hypothesis it tested.

| Risk | Required items to reach `ready` |
|---|---|
| `low` | `repro_before`, `repro_after`, `tests` (no new failures), `diff_scope`; **if UI**: `story_render` (0 failed, 0 uncovered) + `story_interaction` |
| `medium` | low + `regression_probes` (0 failed) + `intent_probes` for the area + `bug_review` with no ≥ medium finding; **if UI**: `story_visual_diff` (0 unexplained); **if user-facing**: persona study in evidence |
| `high` | medium + `traffic_replay` (0 unexplained diffs) + a named human approving C; **if UI**: `recording` or `terminal_recording` of the changed flow + human approval of each visual change; **if user-facing**: `voxq_study` with `expect_met` |
| `critical` | high; auto-land never; landing mode is forge object only |

### 8.2 Landing

`LandingMode = 'devenv_live' | 'trail_ref' | 'radicle_patch' | 'tangled_pull' | 'auto_land'`. Modes compose: `cart` above lands as `trail_ref` *and* `devenv_live` (patch applied into the running devenv via structured process restart, so a human can try it through a portal before anyone reads a diff). `auto_land` commits to the default branch with trailers `Ephyra-Trail: <id>` and `Entire-Checkpoint: <sha>` so provenance survives any forge. A Sapling stack lands through one of these modes and simply turns public. Base moved during `proving`/`ready` → rebase in sandbox; conflicts → `patching`; conflicts outside the trail's touched files → `parked` for a human.

### 8.3 Post-landing watch

`watch.json`: `{ window_s, fingerprints: [...], area_probes: [...], baseline: {error_rate, p95}, rollback: {...} }`. Rollback fires automatically when any of these hold inside the window:

| Criterion | Default |
|---|---|
| Original fingerprint recurs | ≥ 1 occurrence for `high`, ≥ 3 for `low/medium` |
| New fingerprint whose top app frame is in touched files | ≥ 1 |
| Any regression, intent or story probe for the area fails twice consecutively | — |
| Error rate for touched routes > baseline × 1.5 for 10 min | — |
| Tracer bullets in touched code cluster into a new group | advisory only |

Rollback = revert via the same landing mode, trail → `rolled_back`, reopened at `rev+1` in `researching` with the watch data as evidence. A trail that survives its window becomes `closed`, its `repro_before` probe is registered as a regression probe, and its approved story snapshots become the new visual baseline.

## 9. Event → action

Events are delivered to the trail's running agent when one exists, otherwise they resume it.

| Event | Trail action |
|---|---|
| `new_signal` merged into trail | Attach; if in `proving`/`ready`, re-run repro against the new instance; bump severity if the score rose |
| `human_comment` | Reply in the trail; if it contains a request, treat as `revise` at the current checkpoint |
| `checkpoint_decided{approve | revise}` | Advance, or return to the producing state with the note as a constraint |
| `spend_decided{approve | reject}` | Start the real-respondent voxq run, or continue without it (failing the proof if it was required) |
| `proof_failed` | `patching` with the failing item; after `max_attempts` (default 3) → `parked` + inbox |
| `base_moved` | Rebase in sandbox; re-prove if touched files overlap the new commits |
| `probe_regressed_after_landing` | Rollback per §8.3; open `rev+1` |
| `child_trail_finished` | Parent resumes with the child's proof bundle as evidence |
| `parent_trail_landed` | Dependent (`conflicts_with`) trail starts `researching` |
| `claimed_by_human`, `human_revision` (Sapling amend or push to the worktree) | Stop agent, release sandbox lease, keep worktree; `handed_off`; a revision becomes the new head and proofs re-run |
| `released_by_human` | Resume at the state the human left, with their commits as the new head |
| `budget_exceeded` | `parked` with a cost summary; inbox item "continue with more budget?" |
| `intent_updated` (intents file changed) | Re-run that intent's probes; any trail whose hypothesis cites it gets a `human_comment` from the system |
| `forge_event` (patch review/comment on a mirror) | Translate to `human_comment` or `checkpoint_decided` via the forge adapter |

## 10. What humans do

- **Write intents and policy.** The two files humans own are `intents/*.md` and `ephyra/autonomy.md`. This is where the core gets hardened.
- **Decide at checkpoints** from the inbox; most days a few `a`/`r` keystrokes on the medium-risk areas, zero on the loose edges.
- **Approve spend.** Real people cost money: every voxq respondent run is an `a` on a spend item, or a monthly budget a named human wrote into an area.
- **Multiplayer trails.** A trail is a thread anyone can join: comments are events, the agent answers in place, humans can push commits to the trail's worktree without claiming it.
- **Take over.** `t` / `ephyra claim <trail>` hands the worktree and evidence to the human; the agent stops but the record keeps accruing. `ephyra release <trail>` hands it back. With Sapling, the trail is a draft stack in your smartlog and ISL: `sl goto` + `sl amend` is a take-over, landing it is accepting it; plain git refs do the same.
- **Skip.** Analogue of PostHog's `skip-self-driving`: a `claimed_by_human` event; a forge label/COB tag `ephyra:skip` on a mirrored object; or `skip: true` on an area. Skipped signals are still triaged and recorded so the regression memory stays complete.
- **Review the shadow report** weekly and move areas between `shadow` and `enforce`, or change risk levels, as track record warrants.

## 11. Jellyware loop: Ephyra evolving its own agent (later milestone)

Every finished trail is a labelled example: inputs (signal, evidence, area policy), the loop's choices (route, hypothesis, plan, patch), the human verdicts at A/B/C, and ground truth (proof outcome, watch survival or rollback, cost). Ephyra's agent prompts, skills and `autonomy.md` are text, so they register as Not Organic evolution artifacts (`prompt`, `skill`, `policy`, content-addressed by digest). An evaluation runner (a `runtime_bundle`) replays held-out closed trails through triage, hypothesis and plan offline — never landing anything — and posts `notorganic-objective-metrics-v1` evidence against the candidate digest: `route_agreement` with human verdicts, `duplicate_precision`, `proof_first_pass`, `watch_survival`, `human_revise_rate`, `cost_per_closed_trail` (each 0–1 with `sample_count`). `evolve_prompt` and `evolve_policy` jobs then search a MAP-Elites archive with niches of area risk × signal kind, so a candidate good at low-risk UI copy cannot displace one good at payments regressions. Nothing activates itself: the inbox shows the `evaluation_report` beside the active revision, and a human activates a candidate through the active-pointer compare-and-swap (`expected_revision`), which records who did it. M4; it needs a few hundred closed trails to mean anything.

## 12. MVP and milestones

**Dogfood target: voxq.** Both candidates are the user's, on Radicle, devenv and Railway. voxq is the recommendation because it alone has a deployed multi-service production surface (studio, landing, docs and blog on Railway; a Rust engine behind a Bun BFF) and real user-facing flows, so every signal source, Radicle landing, Storybook proof and voxq-on-voxq studies get exercised, and its two languages test the sandbox. Textbook's production is a landing page with `/healthz`: almost nothing to sense. It becomes the second target in M2 to prove `terminal_recording`, and since Ephyra's inbox is OpenTUI with Textbook stories from day one, Textbook is dogfooded regardless. voxq needs two prerequisites, by a human or the first trails: an OTel exporter for the engine and BFF, and a Storybook in `webapp/` (neither exists today).

**MVP (M0) — one service, one loop, one human.** voxq studio: production errors via OTel → fingerprint dedupe → extraction + judgement triage (hosted through Not Organic; the registry can already point at BYOK or a local d1) → trail record in git → agent research (traces + code graph only) → repro in a devenv sandbox → patch → proof bundle at `low` requirements → landing as `trail_ref` + `devenv_live` → the OpenTUI inbox with `a/r/x/t/o` → post-landing watch on the original fingerprint with automatic revert. No hunters, no intents, one area in `shadow`. Success criterion: a real production error becomes a landed, watched fix with no human typing anything except `a`.

| Milestone | Adds |
|---|---|
| **M1 — Memory and the forge** | **Radicle patch landing** with review/comment translation (both dogfood repos live there); closed trails → regression probes; `intents/*.md` with `http`/`trace`/`script`/`story` probes and drift scoring; `regression_of` and `conflicts_with`; `entire search` as evidence; per-identity thresholds with a calibration report |
| **M2 — Proof and hunting** | Storybook and Textbook proof items with the per-risk rules; `story_render` hunter; Textbook as second dogfood; traffic-replay, property and tracer-bullet hunters; `bug_review`; `autonomy.md` prose evaluated by the decision backend; shadow report; `auto_land` for `low`; self-hosted d1/Clef verified end to end |
| **M3 — People** | voxq persona studies and real-respondent tests with spend approval; `voxq` intent probes; `agent` intent probes and exploratory hunting; multiplayer comments and claim/release; Sapling human surface; Tangled pull landing |
| **M4 — Jellyware loop** | §11: evaluation set from closed trails, evolution jobs, human-activated revisions |

## Open questions for the user

1. Default landing for medium-risk areas: is `devenv_live` the primary experience with forge objects as a mirror, or the reverse?
2. Should `agent` intent probes ever run against production with writes, or only staging/sandbox?
3. Who may flip an area from `shadow` to `enforce`: anyone with repo write, or a named list in `autonomy.md`?
4. ~~**BYOK path.**~~ Settled (user, 2026-11-06): BYOK is each application's own job, by design. Ephyra calls TypeSafe, Cloudflare or a d1 host directly with the user's key and meters it locally. Not Organic does not grow BYOK.
5. **Textbook headless render.** Recording is interactive (`R` key, Canvas Record) and e2e goes through VHS. `story_render` needs a non-interactive "render story at viewport, emit frame/tape" command: add it to textbook in M2, or drive VHS from Ephyra?
6. **Sapling over Radicle/Tangled.** Git-mode push/pull through `git-remote-rad` or knot remotes, and whether mutation metadata survives the round trip, are unverified. M3 spike before committing?
7. **Standing voxq budgets.** Is a pre-approved monthly `voxq_budget_usd` per area acceptable for scheduled probes, or must every real-respondent run be approved individually?
8. **Evolution contract.** Not Organic's active revision requires a `pedagogy_revision_manifest` (Keating's). Does Ephyra get its own manifest and evidence contract, or do we generalise the existing one?
9. **voxq prerequisites.** OTel export and a Storybook do not exist in voxq yet: human prerequisite before M0, or the first trails?
