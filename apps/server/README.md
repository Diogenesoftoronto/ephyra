# @ephyra/server

The control plane: OTLP ingest, triage, the trail engine, effect wiring, the HTTP API and the inbox.

## How it fits together

`event → state machine (core/lifecycle) → git journal (CAS) → projection → effects`. Effects run through
the operation ledger, so a replay never repeats a side effect. Long work (triage, agent steps, proof, the
post-landing watch) runs as jobs on a durable queue.

| Piece | File |
|---|---|
| Composition root (config → stores → engine → handlers → HTTP) | `src/compose.ts` |
| Engine and job loop | `src/wiring/runtime.ts` |
| Signal → triage → trail | `src/wiring/intake.ts` |
| Agent steps and proof | `src/wiring/agents.ts` |
| Checkpoints, inbox, decide/actions, audit | `src/wiring/human.ts` |
| Landing, watch, rollback | `src/wiring/landing.ts` |
| Convex schema and functions | `convex/` |
| Convex-backed stores | `src/convex/stores.ts` |

## Persistence

Convex is the durable store (signals, trails, events, inbox, jobs, operation ledger, hash-chained audit).
Every Convex function requires `EPHYRA_CONVEX_SECRET`, which must be set on both the Convex deployment and
the server. Without `CONVEX_URL` the server runs in memory (development only; state is lost on restart).

## Configuration

See `src/config.ts`. The main variables:

| Variable | Meaning |
|---|---|
| `EPHYRA_API_TOKEN` | Bearer token for `/v1/*` and `/otlp/*` (send `X-Ephyra-Principal` too) |
| `CONVEX_URL`, `EPHYRA_CONVEX_SECRET` | Convex deployment and its shared secret |
| `EPHYRA_REPO_URL`, `EPHYRA_BASE_REF`, `EPHYRA_REPO_ID` | The repository this deployment drives. Without it, signals are stored but not triaged |
| `EPHYRA_AUTONOMY_FILE`, `EPHYRA_THRESHOLDS_FILE` | Policy files (shadow-mode templates otherwise) |
| `EPHYRA_EXTRACT` | `parser` (default), `workers-ai`, `none` |
| `EPHYRA_DECIDE` | `none` (default: every signal goes to a human), `typesafe`, `systemone` |
| `EPHYRA_AGENT` | `none` (default), `claude-code`, `codex`, `amp` (the CLI must be in the image) |
| `EPHYRA_DRAFT` | Velum's model: `none` (default), `notorganic`, `anthropic`, `openai`, `fake` |
| `EPHYRA_DRAFT_MODEL` | Model id or gateway alias for Velum (defaults: `balanced` on Not Organic, `claude-sonnet-5-5`, `gpt-6.1-sol`) |
| `EPHYRA_DRAFT_ANTHROPIC_API_KEY`, `EPHYRA_DRAFT_OPENAI_API_KEY` | Bring-your-own keys for `EPHYRA_DRAFT=anthropic` / `openai` |
| `EPHYRA_CONSOLE_DIR` | Built web console served at `/app/` when the directory has an `index.html` (default `apps/console/dist`) |

## The web console API

`design/05-console.md` is the contract; the shapes are in `packages/core/src/console.ts`. All routes use the `/v1` authentication
(session token, or service token plus `X-Ephyra-Principal`); mutations need an approver when sign-in is on, and **publishing a draft
needs a signed-in approver whenever approvers are configured**. Every response is validated with the core schemas before it is sent.

| Route | Returns |
|---|---|
| `GET /v1/me` | Authenticated principal, identity kind and server-derived decision permission for the console |
| `GET /v1/personas` | `Persona[]` |
| `GET /v1/usage?from&to&persona&engine&trail` | `UsageSummary`; default window the last 7 days (at most 366), every UTC day present, `persona=unattributed` for work with no persona |
| `GET /v1/usage/entries?…&cursor&limit` | `{ entries, cursor? }`, newest first, `limit` 1 to 200 |
| `GET /v1/activity?limit` | `ActivityItem[]`: running first (with `startedAt`), then waiting and recent, newest first |
| `GET /v1/docs`, `GET /v1/docs/:path` | `PolicyDoc` with digest and parser warnings, plus (additive) `sketches` on the autonomy document |
| `POST /v1/drafts` `{path}`, `GET /v1/drafts?status`, `GET /v1/drafts/:id` | `Draft` (plus additive `sketches`) |
| `POST /v1/drafts/:id/messages` `{text, quotes?}` | Appends the message and Velum's reply. `Idempotency-Key` makes a retry return the draft without asking the model again |
| `PUT /v1/drafts/:id/content` `{content, baseDigest}`, `PUT /v1/drafts/:id/sketches` `{sketches, baseDigest}` | Manual edit / edit of the application map (rendered through `sketchToArea` → `renderAutonomy`) |
| `POST /v1/drafts/:id/apply` `{messageId}`, `…/publish`, `…/discard` | See below |
| `GET /v1/runs?trail&status&limit`, `GET /v1/runs/:id` | `AgentRun[]` (running first) / `AgentRun` |
| `GET /v1/runs/:id/events?after=<seq>` | `AgentRunEvent[]`; with `Accept: text/event-stream` a live SSE stream (`id:` is the seq, `Last-Event-ID` resumes, a final `event: end` carries the status) |
| `POST /v1/runs/:id/policy` | Ingestion for the Amp harness plugin's `tool.call` decisions (service token allowed even with sign-in on) |

**Documents.** `autonomy.md`, `thresholds.yaml` and `intents/<name>.md`. Source order for each: the configured file
(`EPHYRA_AUTONOMY_FILE`, `EPHYRA_THRESHOLDS_FILE`), then the deployment repository at `EPHYRA_BASE_REF`, then the shipped template
(autonomy and thresholds only). The digest is the SHA-256 of the text. Parse errors are reported in `warnings` with an `error:`
prefix and block publishing; other warnings do not. A draft of a new intent starts from an empty document.

**Publishing.** Refused (409) when the draft isn't open, has errors, or the document's digest moved since `baseDigest`. Otherwise it
writes a commit (the base ref's tree with the new file, or a root commit when the base ref doesn't exist) to
`refs/ephyra/policy/<draft-id>` with `Ephyra-Draft:` and `Ephyra-Approver:` trailers, creating the ref with compare-and-swap, appends the
audit entry `policy.publish`, and marks the draft published. A replay after a crash finds the identical commit and reuses it. The live
policy is never changed; it changes only when that commit lands on the base ref through the usual landing.

**Velum.** The `DraftModel` port has four adapters: Not Organic (`POST /v1/chat/completions` on `NOTORGANIC_ISSUER`, DPoP-bound with the
billing account's sign-in session, with a cost ceiling header), Anthropic and OpenAI (bring your own key), and a deterministic fake.
Velum replies with JSON `{text, proposal?, spec?}`; the system prompt comes from `velumPrompt` plus the application map. The server
re-parses every proposal for warnings, validates every `spec` with `validateVelumSpec` (invalid → dropped with a system note), renders
`proposal.sketches` itself (any `content` sent with sketches is ignored), wraps quoted signal or comment text as
`<untrusted_signal>` / `<untrusted_comment>`, and answers an unavailable model with a system message and an `unavailable` usage row,
never a made-up reply. Provider prices are not reported by Anthropic or OpenAI, so BYOK Velum rows have an unknown cost.

**Usage.** One idempotent row per unit of work: model calls (extract, triage) through the models `UsageHook`, each agent step (tokens,
cost and model from `AgentResult.usage`, wall time; failed and `Unverified` steps too), each proof run, and each Velum reply.
`billedTo` comes from the configured backend (Not Organic hosted → `notorganic`, keyed providers → `byok`, local CLIs and parsers →
`local`, a keyless custom endpoint → `unknown`). An unknown cost is `null`, counted in `unknownCost`, never added as 0. Notes pass
through `safeNote`, which scrubs credential shapes. The ledger is in memory or the Convex `usage` table; a ledger outage is logged and
never fails the work it measures.

**Runs.** Each agent step creates an `AgentRun` (id `<trail>.<rev>.<step>.<attempt>`) with an executor (`orb` with project, `runner`
with id, `local`, or the runner's name), appends the engine's normalized events (see `packages/agent`) with a gap-free `seq`, merges
the Amp thread URL and a portal URL when the stream reports them, and closes with status, engine, usage and error. Events are buffered
for 250 ms before they are stored. A run left `running` by a crashed server is closed as failed on the next boot. Stores: memory and the
Convex `runs` / `runEvents` tables (secret-gated, convex-tested).

**Console.** When `EPHYRA_CONSOLE_DIR/index.html` exists, `/app/` serves the built console with SPA fallback (missing assets 404, never
outside the directory); `/v1` keeps its authentication.

Console decisions include the reviewed `bound` (revision, head and proof digest). If that binding differs from the
current inbox item, the server refuses it before recording a decision. Trail detail exposes bounded plain-text
`hypothesis.md` and `plan.md` from the matching journal revision, plus the recorded proof events. Missing or moving
journal content is returned as unavailable. No arbitrary file paths are accepted from the console.

## Verified and Unverified (console)

Verified offline (no network): usage aggregation (property tests: totals equal the sum of the persona, engine and day groups; unknown
costs counted, never summed as 0; paging covers every entry once), recording from the models hook, agent steps and proof through the
composed server, activity derivation, docs, draft chat/apply/edit/discard/publish including the policy ref (CAS, replay, concurrent
publish) and audit entry, the application map routes, Velum adapters against fake `fetch`, run routes including SSE ordering, resume
and close, the plugin policy route, Convex functions (convex-test), and static serving with traversal attempts.

**Unverified:**
- A live Velum reply. One attempt with the Anthropic adapter returned HTTP 400 from the provider (*credit balance too low* on the key
  used), so no live reply was seen. Not Organic chat with the billing account's DPoP token is also unseen live: the `infer:<model>`
  scope Velum needs is requested at sign-in only when `EPHYRA_DRAFT=notorganic`, and the gateway/client catalog must allow it.
- The success path of the Amp, Claude Code and Codex stream normalizers on live runs (fixtures follow the documented formats; only the
  Amp reauthentication failure is a real capture), and the portal URL appearing in an `amp orb portal` result.
- **Live plugin reporting.** `POST /v1/runs/:id/policy` is the ingestion path for the Ephyra harness plugin
  (`.amp/plugins/ephyra.ts`, design/03), but that plugin is not built, so no policy event has come from a real Amp run. Policy events
  exist only when a caller posts them; none are ever synthesised.
- Landing the published policy commit on Radicle or Tangled (the commit only lands through the forge adapters that are verified), and
  the Convex `drafts`, `runs` and `runEvents` functions against a live deployment.
- Orb and runner Amp steps other than research, plan and review still need the plugin's `ephyra_report` tool (unchanged).

## Deploying

Durable state is hosted Convex: team `Tungsten-Cube`, project `ephyra`.

| Deployment | URL | Use |
|---|---|---|
| prod `loyal-bass-393` | https://loyal-bass-393.convex.cloud | Railway server |
| dev `fabulous-newt-583` | https://fabulous-newt-583.convex.cloud | local development and `EPHYRA_E2E_CONVEX` |

1. Convex functions: in `apps/server`, `bunx convex deploy` (prod) or `bunx convex dev --once` (dev).
   Set the shared secret on each deployment once: `bunx convex env set [--prod] EPHYRA_CONVEX_SECRET <secret>`.
2. Railway infrastructure is `.railway/railway.ts`. Use the CLI pinned in `.railway/node_modules/.bin/railway`:
   `railway config plan`, then `railway config apply`.
3. Server secrets on Railway, once: `EPHYRA_CONVEX_SECRET` and `EPHYRA_API_TOKEN` on `server`.
4. Server code: `railway up --service server`.

## Sign in with Not Organic

When `EPHYRA_PUBLIC_ORIGIN` and `EPHYRA_SESSION_KEY` are set, people sign in with their Not Organic account and the
server stops accepting trail changes from the service token.

- Browser: `/auth/login` → `id.notorganic.info` (PKCE S256) → `/auth/callback`. The server exchanges the code at
  `api.notorganic.info/v1/public/token` with its own DPoP key, then checks `/v1/account` against the token's DID,
  issuer and product before creating a session.
- Terminal: `ephyra login <server-url>` prints a link and a code; the browser page shows the same code and an Approve
  button; the CLI then collects its session once and stores it in `~/.config/ephyra/credentials.json` (mode 600).
  `ephyra whoami`, `ephyra logout`.
- Sessions live in Convex: the session token only as a SHA-256 hash, the Not Organic refresh token and DPoP key
  sealed with AES-256-GCM under `EPHYRA_SESSION_KEY`. Refresh-token rotation is saved with compare-and-swap.
- Changing trails needs a signed-in account listed in `EPHYRA_APPROVER_DIDS`; other signed-in accounts can read.
- `EPHYRA_DECIDE=notorganic` / `EPHYRA_EXTRACT=notorganic` run triage on Not Organic judgement and extraction,
  paid from `EPHYRA_BILLING_DID` (default: the first approver), using that account's sign-in session.

**Registration.** Not Organic only signs users into approved client origins. Ephyra's origin is in the gateway's
`PUBLIC_CLIENT_PRODUCT_CATALOG` on the notorganic-provider Railway project, mapped to product `notorganic`, so tokens
carry `product: "notorganic"` (set `NOTORGANIC_PRODUCT` to match). A dedicated `ephyra` product id would need a
release of notorganic-provider (`PRODUCT_IDS` in `packages/contracts/src/catalog.ts`).

## Tests

`bun test apps/server`: unit tests, Convex function tests (convex-test), and an end-to-end test that drives
an OTLP error through triage, agent steps, real proof, three HTTP approvals, landing, the watch and a
rollback. Run it against a live Convex with `EPHYRA_E2E_CONVEX=1 CONVEX_URL=… EPHYRA_CONVEX_SECRET=…`.

## Application UI stories

`bun run --filter @ephyra/server storybook` opens the browser UI workshop on port 6006;
`bun run --filter @ephyra/server build-storybook` builds it into `dist/storybook`. `devenv up`
also starts Storybook. The seven sign-in stories use the same view functions as the server, with
example data in a sandboxed frame so the approval form cannot submit. They cover both account roles,
terminal approval, successful sign-in, an expired request and an error. The terminal inbox is an
OpenTUI application and its stories live in `apps/cli/src/inbox.stories.ts` for Textbook instead.

New browser-facing application components and meaningful states should be added to Storybook alongside
their implementation. The public marketing site is separate; the web console is `apps/console`.
