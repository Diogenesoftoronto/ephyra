# Research brief — "self-driving software, off GitHub" (2026-11-06)

## The user's ask (paraphrased, keep their words where possible)
- Open-source, **self-hostable end to end** alternative to Macroscope's feature set, deployable on **Railway** (and on own hardware).
- Specifically the **self-driving PRs** loop, but working with **devenv** and **without PRs** ("sort of like trails").
- **Self-driving applications**: fix errors found in production, but also *actively look for and test for them*, check for **past issues** (regressions), and **monitor intent** (is the app still doing what it's meant to do?).
- Use **System One models** — **Clairic** (Cloudflare), **Jev** (TypeSafe AI), and "the other available services offered by models in *notorganic*" — as the **provider and account system**. (We could not identify "notorganic"; treat it as an unknown provider/account hub to be confirmed. Design the provider layer so it's pluggable.)
- Model gathers **evidence** with "**voxq**" (unidentified — confirm with user; treat as an evidence/search tool) or **`entire search`**.
- **HumanLayer**-style design (human-in-the-loop approvals, 12-factor agents, research→plan→implement with checkpoints).
- Vision: move beyond software to **jellyware**.
- Must work with **Radicle** or **Tangled** forges, not GitHub-tied.

## Reference products
### Macroscope Murmur (self-driving PRs) — beta, Sep 2026
- Per-task cloud VM built from a baked image; at Macroscope each VM runs a single-node k8s with dozens of services. Agents run tests, call services, read logs, click the UI; PRs carry screenshots/recordings as evidence.
- **Service profiles**: VM image + network boundary + credentials + access policy, scoped to users/teams (e.g. a "production investigation" profile can reach logs/observability/operational DBs). Terraform config. Audit logs.
- **Self-driving loop** = event → action, delivered to a *still-running* agent (keeps context):
  review comment → change + reply; changes requested → fix + re-request; CI fail → investigate/fix/push; base moved → rebase/resolve; child finished → continue parent. Stops at "clean, ready for human approval". Agents never merge their own PRs.
- **Director**: local Claude Code/Codex session + Murmur CLI/MCP; plans, spawns, monitors via real-time events, reviews, recommends merge/follow-up/kill. Recursive child agents. **Flights** = Markdown DAG of agent tasks.
- Intake: Slack, Linear, GitHub/CI, REST/MCP, schedules, events, always-on watchers (Slack, Datadog).
- Reportedly runs on **Temporal**. BYO model keys.
- **Hard GitHub dependency** everywhere (org connect, PR comments, check runs, re-review, rebases).
### Macroscope Approvability
- 3 gates: eligibility (agent classifies change type/scope/risk vs policy + author track record), correctness (bug review must be clean; ≥medium blocks), ownership (CODEOWNERS, optional).
- Policy in plain English: `.macroscope/approvability.md`. Rollout: shadow "Would Approve" for ~a week, then enable. Decision = GitHub Check Run + bot APPROVE review.
- Also: "Fix It For Me" (review finding → fix that iterates on CI), CLI `/macroscope:autoloop` (review/validate/fix loop *before* a PR exists).
### PostHog "self-driving" (posthog.com/self-driving; page is JS-rendered)
- A **Self-driving Inbox** fed by **signal emitters** (errors, insight alerts, ~30 warehouse sources, etc.); agent researches a signal, checks in-flight work (dedupe against its own open PRs), opens a PR. Label `skip-self-driving` lets a human claim work. Has had issues with duplicate competing PRs → added an in-flight check.
### Amp — "Orbs and Jellyware" (Raising an Agent S2E2, Aug 2026)
- **Jellyware**: hardware → firmware → software → *jellyware*: high-quality software that fully embraces being malleable and fast to change; higher risk tolerance because "the pain of a bug is how bad it is × how long it exists in production".
- **Orbs**: isolated cloud box per agent thread, sleeps for free; read-only creds by default. **Portals** (URL to anything running in an Orb). **Puck** meta-agent manages threads/orbs. Multiplayer threads.
- **Verification**: "ask the agent for 100% proof it's correct" — demo videos, testing all combinations, 120fps frame checks for jitter.
- **Production as feedback loop**: "tracer bullet" warning logs (log where you *would* reject without rejecting), watch for hours, cluster failures, gradually "turn the vise", rollback ready, thread multiplayer so humans can step in.
- Review shifts to risk, blast radius, invariants; humans harden the core + AGENTS.md; edges get looser.
- Polling automations (check logs every 30 min post-deploy, watch 500s) — these *report*, they don't fix.

## Building blocks
### System One models (decision/extraction, not text generation)
- **Jev** (TypeSafe AI): state → typed judgments + calibrated probabilities (choices, scores, yes/no). 70–500 ms. $0.042/M input, output free. API `POST https://api.typesafe.ai/v1/systemone`; also OpenRouter, Vercel AI Gateway, Cloudflare Workers AI (`typesafe/jev`, jev-1.14 GA). Proprietary, not self-hostable. Weak at math/counting; literal.
- **Clairic** (Cloudflare, Oct 19 2026, preview): text + ≤4 images + typed field defs → typed values in one forward pass (spans w/ offsets, numbers, dates, durations, lists, estimate distributions w/ median + 80% interval, forecasts), each with p_null + confidence. `@cf/cloudflare/clairic`, 64k ctx, $0.10/M input, ZDR. Weights promised "soon".
- **Clef** (Cloudflare): choice/decision model, **Apache-2.0 weights** → the self-hostable System One option today.
- Use pattern: Clairic extracts values, Jev/Clef decide; an LLM only where generation is needed (patch writing). This is the cheap, fast "always-on" triage tier.
- A TypeSafe skill is installed locally (`typesafe:typesafe-ai`) with live docs/cookbooks.
### Entire (entire.io) — agent session provenance in git
- **Checkpoints**: agent session (transcript, prompts, files, tokens, tool calls) stored as git refs `refs/entire/checkpoints/…` (or branch `entire/checkpoints/v1`), linked by `Entire-Checkpoint` commit trailer; `Entire-Attribution` trailer = agent vs human share. Never adds commits to your branch. Pushes alongside code → **forge-agnostic by construction** (it's just git refs).
- `entire search` = hybrid semantic+keyword over checkpoints, commits, sessions (`--all-repos`). Also `entire blame`, `entire review` (multi-agent branch review), `entire recap`, `entire rewind`, `entire session resume`. `entire-brain` = project memory (checkpoints + code graph) agents can query.
### devenv (cachix)
- 2.x: agents detected via `CLAUDECODE`/`OPENCODE_CLIENT`/`AI_AGENT` → quiet mode; 2.1 **structured process handles** (restart a service without killing the session); auto port fallback for multiple agents (`--strict-ports` to disable); **OpenTelemetry** trace propagation (`TRACEPARENT` into spawned tasks/processes; `--trace-to [format:]destination`, multiple destinations). Nix-based → the *same* env reproduces locally, in a sandbox, and in CI.
### Tangled (AT Protocol forge)
- **Knots** host git; since Oct 30 2026 relaunch (knot2, Rust) knots also hold signed records for issues/PRs/comments/labels, synced via the AT Protocol **firehose**; each repo has its own DID. **bobbin** = read-only AT-Proto data API documented *for agent consumption*. Self-hostable in part or fully; replaceable components.
- **Spindles** = CI: subscribe to knot pipeline events (`sh.tangled.pipeline`) over websocket, stream `sh.tangled.pipeline.status`. Nix deps, Docker per run. XRPC: `org.tangled.event.notifyEvent`, `org.tangled.ci.listWorkflowDefinitions/getWorkflowDefinition/retryPipeline/approvePipeline`, secrets via service auth (DID-signed), HMAC webhooks. Custom spindles exist (e.g. mitchellh's "tack").
### Radicle (p2p forge)
- Collaborative Objects (**COBs**): signed, append-only DAG with CRDT semantics; patches = `xyz.radicle.patch`, issues, identity COB. Patches have revisions + reviews. Seed nodes. **Radicle CI broker** (`cib`) listens to patch/push events from a node and runs adapters (e.g. native adapter via `.radicle/native.yaml`); `rad-ci` for local use. Custom COB types are possible → a natural home for a "trail"/proposal/evidence object.
### HumanLayer
- 12-factor agents (own your prompts/context/control flow; small focused agents; human contact as a tool call; pause/resume via durable state). Advanced Context Engineering: **research → plan → implement** with explicit human alignment checkpoints; keep stages small. CodeLayer "post-IDE IDE", Superhuman-style keyboard-driven approvals.
### Railway
- Hosts long-running services, Postgres/Redis, cron, private networking, volumes; templates for one-click deploy. Caveat to verify: no nested virtualization/KVM for Firecracker-style microVMs → sandboxes likely need containers on Railway, or a self-hosted runner pool on the user's own Nix hardware.

## Unknowns to flag (don't invent)
- "notorganic" (provider/account system) — unidentified.
- "voxq" (evidence tool) — unidentified.
- ~~"trails"~~ — IDENTIFIED: **Entire Trails** (launched Oct 26 2026 with Entire's git forge). Trails replace PRs; a Trail can start from a bug report, feature request or coding agent and span several repos; every push triggers per-project **review agents** (risk, confidence, drift, security, slop, "human review required") run in Daytona/E2B sandboxes, each returning a score + rationale; per-repo **Gates** require human approval + passing CI before merge. CLI: `entire trail create|list|show|approve`, `entire trail finding resolve`. Requires repo hosted on Entire or a GitHub mirror with the Entire GitHub App, so it is not self-hostable and not Radicle/Tangled-friendly. Sources: thenewstack.io/entire-trails-agentic-code-review, entire.com/blog/how-to-run-custom-ai-code-evals-on-every-push-with-trails.
- Railway **Sandboxes** confirmed: GA on all plans since changelog #0308 (Sep 18 2026); create/exec/checkpoint/fork/restore/destroy via CLI + TypeScript SDK; Claude Code/Codex/OpenCode/Pi preinstalled; disk-only checkpoints; `ISOLATED` (default) vs `PRIVATE` network; 30-min idle timeout. Guide: docs.railway.com/guides/code-execution-sandboxes.
- Tangled namespace correction (from platform review): post-Oct-2026 lexicons are `org.tangled.*`, not `sh.tangled.*`.

---

# Round 2 (2026-11-06): the user's answers and new facts

## The user's answers
1. **"notorganic" = Not Organic**, the user's own project (notorganic.info). **"voxq" = voxq**, also the user's (voxq.io). Repos are on this machine:
   - `/home/diogenes/Projects/apps/notorganic-provider` (TS/Bun/Hono gateway + Convex + React portal; devenv; Railway via `.railway/railway.ts` + railpack; Unison port in progress). Docs: README.md, PRODUCT.md, docs/sandbox-execution-graph.md, apps/docs/api.html, packages/contracts/src/*.ts.
   - `/home/diogenes/Projects/apps/voxq` (Rust engine + Bun web studio; devenv; Radicle remote `rad://z3X34hv7fz8WAgzTHnMmhJ8rvZz87`; Railway). Docs: README.md, PRODUCT.md, RADICLE.md, dev-docs/, docs/audience-evidence.md. Binary installed at `~/.cargo/bin/voxq`.
2. **Decision models: the user picks.** They can use hosted ones or bring their own. The user named **Liquid AI d1** as easy to self-host. **Extraction:** Clairic is one of the few options today, but users must be able to plug in their own model and **BYOK**. "The majority of my applications work like this."
3. **UI proof:** devenv is the dev environment. To verify UI, use **Storybook** for web UI and **Textbook** (textbook.sh) for terminal UI.
4. **Sapling** integration "is interesting for sure."
5. **Language: TypeScript** to start ("natural beginning right now and lets us iterate pretty quickly"). Matches Not Organic (Bun/Hono/Zod), DBOS, Railway Sandbox SDK. Rust stays possible later for hot paths.

## Not Organic: what exists (from code, Nov 2026)
- The shared **account layer** for the user's products (Twyne, Keating, Interleave, Stich; voxq connects too). It provides **ATProto identity** (a managed PDS and `did:plc`), a **micro-USD wallet** (grants, debt, reserve before dispatch, then settle or reconcile, `Idempotency-Key` on every metered call), and short-lived **DPoP-bound capability tokens**. A product backend signs a ≤60 s assertion, which the gateway exchanges for a ≤300 s access token carrying capabilities and `max_cost_microusd`.
- An **OpenAI-compatible inference gateway** (`api.notorganic.info`) routed through Portkey. Responses are encrypted with OpenBao Transit. Upstream providers see an HMAC pseudonym, never the DID.
- **`POST /v1/judgement`** (capability `judgement:evaluate`): System One `state` + named `questions` of type `noul | choice | score`. Backends are `judgement` (Jev by default), `judgement-jev`, `judgement-luna` (gpt-6-luna), `judgement-pplx` (perplexity pplx-decider-v1.1-27b, deployable on Runpod at `/v1/systemone`), and `judgement-vision`. A response names the actual backend and version. Fallback requires both `allow_fallback` and operator configuration; there is never a silent switch.
- **`POST /v1/extraction`** (`extraction:run`): Clairic-shaped typed extraction. Field types are text, number, date, time, datetime, duration, list, estimate, forecast. Answers carry p_null, confidence, spans, p10/p90.
- **`/v1/sandbox/runs`** (`sandbox:run|read|cancel`): CPU Python/TS on a Cloudflare Worker Sandbox, capped at 30 s, no egress. CI runners are planned as **Fly Sprites**.
- **`/v1/evolution/*`** (`evolution:read|write|execute`): "continual evolution". Content-addressed artifacts (`prompt`, `self_evolution_source`, `map_elites_configuration`, `map_elites_archive`, `policy`, `skill`, `runtime_bundle`, `evaluation_report`), jobs, evidence, and active revisions.
- **Tangled/Spindle bridge** (contracts `project-execution.ts`, `ci.ts`): a project source is `pds` | `tangled_managed` | `tangled_external` (an AT-URI, so a user can move their knot). The CI trigger is a Notorganic-managed or user-owned Spindle. The runner is a Cloudflare Sandbox or a disposable Fly Sprite. Artifacts are immutable R2 objects. NOTE: these contracts still use `sh.tangled.repo` / `sh.tangled.spindle` AT-URI collections, while Tangled has moved to `org.tangled.*`.
- notorganic-provider routes through operator-held Portkey keys. **BYOK is deliberately not part of Not Organic.** Each application handles its own BYOK separately (user, 2026-11-06), so Ephyra's `byok:<vendor>` routes call vendors directly.
- PRODUCT.md's direction: "a future agent-swarm application should be able to connect Not Organic identity and delegated access, … sandbox execution, continual evolution and payments through one account." **Ephyra is a natural fit for that application.**

## voxq: what exists
- "Ask the models first. Then ask the people." A survey and interview studio. You design a study, **simulate** answers through AI personas (via Not Organic inference), **collect** answers from real people (share link, embed, Prolific or other panels, Frenzy referrals), then **compare** human and simulated answers with population weighting and costs. It supports chat tasks and **first-click and preference tests** (latest commit, Oct 27 2026).
- Agent surfaces: CLI (`voxq create|run|results|export|init`), REST (`voxq serve`), **MCP** (`voxq mcp` / `voxq http-mcp`), and Steel Scheme scripts.
- Honest about evidence: "simulations help generate hypotheses; agreement with respondents does not establish accuracy". Synthetic answers are never treated as measured demand.
- → In Ephyra, voxq is the **human-intent evidence source**: for user-facing intents and changes, run a persona study first (cheap, a hypothesis), then a real-respondent test (first-click, preference, chat task) as proof.

## Liquid AI d1 (decision models)
- Typed decision models. **Open weights** under the LFM Open License: `d1-2B`, `d1-omni-2B` (multimodal text+image+video, built on LFM3-VL-2B; the recommended one), `d1-omni-600M`. Hosted: `d1-ultra`, `d1.1`. Earlier `d1-3B`: 8 ms per question on an RTX 4090, 16 ms on a Jetson AGX Thor. Docs: docs.liquid.ai/lfm/models/decision-models; weights at huggingface.co/LiquidAI. Benchmarks are self-reported.
- → The self-hosted decision backend next to Clef. It runs on a single consumer GPU, or a small one on CPU.

## Textbook (textbook.sh): the user's project
- `/home/diogenes/Projects/apps/textbook`, npm `textbook-sh`. Storybook for OpenTUI terminal components. You write `*.stories.ts`. Modes: TUI, web Canvas (xterm.js live terminal, viewport presets, themes, telemetry inspector, hot reload), docs. It records terminal sessions (`tests/e2e.gif`). Radicle remote `rad://zvBbMB426pBbJ4jmKsTZHSpjmbjK`. devenv + Railway.
- → The proof source for terminal UI: render the affected stories before and after, take recordings, and diff the terminal frames. Storybook does the same for web UI (interaction tests, visual snapshots).

## Sapling (meta/sapling, formerly facebook/sapling)
- An SCM built around **stacks of draft commits** on top of public commits. There are no branch names to manage. `sl amend` **auto-restacks** descendants. It also has `sl absorb`, `sl undo`/`redo`, `sl hide`, and commit **mutation history** (each commit records what it replaced).
- Smartlog (`sl`), the **Interactive Smartlog (ISL)** web UI and VS Code extension (Interactive Split added Mar 2026), and `sl worktree` (Sep 2026 release).
- Works with **git repos**: `sl clone <git-url>` uses git storage. Its GitHub-specific parts are `sl pr`, ghstack and ReviewStack. **Unverified:** whether Sapling's git-mode push and pull work through git remote helpers such as `git-remote-rad` (Radicle) or Tangled knot remotes, and how Sapling's mutation metadata survives a round trip through git.
- → Possible Ephyra mapping: **a trail's patch is a Sapling draft stack**. Trail revisions become mutation history, and a human sees self-driving work in their smartlog. Accepting it means landing the stack, and taking it over means `sl goto` + amend.

## Dogfood candidates
voxq (Rust + web, Radicle, devenv, Railway) and textbook (TS/OpenTUI, Radicle, devenv, Railway). Both are the user's, both are on Radicle, and both already run on devenv.
