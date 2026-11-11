---
title: Configuration
summary: Every environment variable the server, the public site and the CLI read, with defaults. Unset optional features are off.
---

All configuration is environment variables, validated when the server starts. A missing required value or an invalid combination stops the server with a message naming the variable. Nothing falls back silently to a different backend.

Secrets are read from the environment and never logged, written to a journal, committed or sent to a model.

## Core

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_API_TOKEN` | required | Service token for `/v1/*` and `/otlp/*`. At least 16 characters. Callers send `X-Ephyra-Principal` with it. |
| `PORT` | `3000` | Listening port. |
| `EPHYRA_DATA_DIR` | `/data` | Git journals, repository mirrors and local operation records. Persist it. |
| `CONVEX_URL` | unset | The Convex deployment. Unset means memory mode: state is lost on restart. |
| `EPHYRA_CONVEX_SECRET` | unset | Shared secret, set on both the Convex deployment and the server. |
| `EPHYRA_CONSOLE_DIR` | `apps/console/dist` | The built console, served at `/app/` when it contains an `index.html`. |

## Repository

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_REPO_URL` | unset | The repository this deployment drives. Without it, signals are stored but not triaged. |
| `EPHYRA_BASE_REF` | `refs/heads/main` | The branch repairs build on. |
| `EPHYRA_REPO_ID` | `default` | A name for the repository in records. |
| `EPHYRA_FORGE` | `plain` | `plain`, `radicle` or `tangled`. The last two need host integration. |
| `EPHYRA_AUTONOMY_FILE` | unset | Path to `autonomy.md`. The shadow-mode template is used otherwise. |
| `EPHYRA_THRESHOLDS_FILE` | unset | Path to `thresholds.yaml`. |

## Sign-in

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_PUBLIC_ORIGIN` | unset | The server's public address as a bare origin, with no path. Enables browser sign-in. |
| `EPHYRA_SESSION_KEY` | unset | 32 random bytes, base64 or base64url. |
| `EPHYRA_APPROVER_DIDS` | empty | Comma-separated Not Organic DIDs that may approve. |
| `NOTORGANIC_ISSUER` | `https://api.notorganic.info` | Identity provider API. |
| `NOTORGANIC_AUTHORIZATION_URL` | `https://id.notorganic.info/authorize` | Where sign-in sends the browser. |
| `NOTORGANIC_PRODUCT` | `notorganic` | The product this origin is registered under. |
| `EPHYRA_BILLING_DID` | unset | The account hosted model calls are billed to. |

## Models

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_EXTRACT` | `parser` | How signals are structured: `parser` (deterministic, no model), `workers-ai`, `notorganic` or `none`. |
| `EPHYRA_DECIDE` | `none` | The triage model: `none` (every signal goes to a person), `typesafe`, `systemone` or `notorganic`. |
| `EPHYRA_SYSTEMONE_URL`, `EPHYRA_SYSTEMONE_KEY`, `EPHYRA_SYSTEMONE_MODEL` | unset | For `EPHYRA_DECIDE=systemone`. |
| `EPHYRA_DRAFT` | `none` | Velum's model for policy drafting: `none`, `notorganic`, `anthropic`, `openai`, `ampersand` or `fake`. |
| `EPHYRA_DRAFT_MODEL` | per provider | Model id or gateway alias for Velum. |
| `EPHYRA_DRAFT_ANTHROPIC_API_KEY`, `EPHYRA_DRAFT_OPENAI_API_KEY` | unset | Required for the matching `EPHYRA_DRAFT` value. |
| `EPHYRA_HUMANS_API_KEY` | unset | Required when drafting or the tutor uses `ampersand`. |
| `EPHYRA_TUTOR` | `none` | &Tutor's backend: `none`, `notorganic` or `ampersand`. |
| `EPHYRA_TUTOR_MAX_COST_MICROUSD` | `100000` | Ceiling for one tutor consultation. |

## Agents and execution

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_AGENT` | `none` | The coding agent: `none`, `claude-code`, `codex` or `amp`. The CLI must be in the runner image. |
| `EPHYRA_AGENT_MODEL` | unset | Model for the agent, where the CLI accepts one. |
| `EPHYRA_AMP_EXECUTOR` | `local` | Where Amp runs: `local`, `orb` or `runner`. |
| `EPHYRA_AMP_PROJECT`, `EPHYRA_AMP_RUNNER_ID` | unset | For the `orb` and `runner` executors. |
| `EPHYRA_AMP_MODE` | `medium` | `low`, `medium`, `high` or `ultra`. |
| `EPHYRA_HOSTED_RUNNER` | `none` | Runner for hosted accounts: `none` or `railway`. |
| `EPHYRA_HOSTED_ACCOUNTS` | empty | Accounts granted hosted execution. |
| `EPHYRA_RAILWAY_TOKEN`, `EPHYRA_RAILWAY_ENVIRONMENT_ID` | unset | For `EPHYRA_HOSTED_RUNNER=railway`. |
| `EPHYRA_RAILWAY_CHECKPOINT`, `EPHYRA_RAILWAY_REGION` | unset | Optional sandbox image and placement. |
| `EPHYRA_RAILWAY_CPU` | `1` | Sandbox CPUs, up to 32. |
| `EPHYRA_RAILWAY_MEMORY_MB` | `2000` | Sandbox memory. |
| `EPHYRA_RAILWAY_IDLE_MINUTES` | `5` | Idle time before a sandbox stops. |

## Budgets and timing

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_TRAIL_TOKENS` | `2000000` | Reported tokens per quest. |
| `EPHYRA_TRAIL_WALLCLOCK_S` | `14400` | Execution seconds per quest. |
| `EPHYRA_TRAIL_SPEND_MICROUSD` | `0` | Metered inference spend per quest. Zero is no allowance. |
| `EPHYRA_REQUIRE_KNOWN_COST` | `false` | Stop when a required cost is unknown. Always true for personal workspaces. |
| `EPHYRA_STEP_TIMEOUT_S` | `1800` | Longest a single agent step may run. |
| `EPHYRA_WATCH_EVERY_S` | `300` | How often the watch samples. |

[Budgets and usage](./budgets) explains how these count.

## Proof and evidence

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_PROOF_RECEIPTS_DIR` | unset | Operator-owned absolute path where study receipts are placed. |
| `EPHYRA_PROOF_TRUST_FILE` | unset | Operator-owned absolute path to the grants file. See [Study evidence](./study-evidence). |
| `EPHYRA_TRACTION_ORIGIN`, `EPHYRA_TRACTION_TOKEN`, `EPHYRA_TRACTION_PROJECTS` | unset | Scoped Traction evidence for research. |

## Voice

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_VOICE` | `none` | `none`, `notorganic` or `compatible`. |
| `EPHYRA_VOICE_URL`, `EPHYRA_VOICE_API_KEY` | unset | For a compatible speech service. |
| `EPHYRA_VOICE_STT_MODEL`, `EPHYRA_VOICE_TTS_MODEL`, `EPHYRA_VOICE_NAME` | unset | Models and voice. |
| `EPHYRA_VOICE_MAX_COST_MICROUSD` | `100000` | Ceiling for one voice exchange. |

## The public site

The site that serves these pages (`apps/web`) has its own settings:

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_SITE_ORIGIN` | `http://127.0.0.1:$PORT` | Canonical origin of the public site. |
| `EPHYRA_DOCS_ORIGIN` | unset | A host of its own for the documentation, such as `https://docs.example.com`. Unset, the docs are served under `/docs`. Set, `/docs/...` redirects there. |
| `EPHYRA_API_ORIGIN` | unset | The Ephyra server. Links the app, `auth.md` and agent access. |
| `EPHYRA_SITE_REDIRECT_ORIGINS` | empty | Old origins that redirect to the canonical one. |
| `EPHYRA_BLOG_PUBLICATION_URI` | unset | Connects the journal. |
| `EPHYRA_HOME_CUT` | `e` | Which landing page is served at `/`. |

## The CLI

| Variable | Meaning |
|---|---|
| `EPHYRA_URL` | The server. Overrides the one saved by `ephyra login`. |
| `EPHYRA_API_TOKEN`, `EPHYRA_PRINCIPAL` | Service-token access for automation. Both are required together. |
| `EPHYRA_CREDENTIALS` | Path of the credentials file. Default `~/.config/ephyra/credentials.json`. |
| `EPHYRA_DOCS_URL` | Where `ephyra docs` and the inbox's `d` key point. |
| `EPHYRA_TIPS` | `0` hides the inbox tip line. |
| `EPHYRA_ANSI` | `1` uses the plain ANSI renderer for the inbox. |
| `NO_COLOR` | Any value turns colour off. |

## Next

- [Bring a server up in stages](./self-hosting)
- [The API these settings expose](./api)
