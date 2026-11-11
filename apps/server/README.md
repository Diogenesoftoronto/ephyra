# @ephyra/server

The control plane: OTLP ingest, triage, the trail engine, effect wiring, the HTTP API and the inbox.

## Personal accounts and setup

`composeApplication` routes signed-in humans to their own workspace; service tokens retain the deployment workspace.
Not Organic supplies the authenticated DID. Each account can configure its GitHub, GitLab, Forgejo, native Radicle, native Tangled or public HTTPS Git repository, optional scoped token,
and Hosted, OpenAI, Anthropic-compatible Messages, or OpenAI-compatible Chat Completions model access.
Personal configuration never inherits deployment provider credentials, policy overrides, or the trusted local runner.
Hosted execution uses the selected account model with an isolated Railway sandbox when the operator grants that account access.
Model and repository credentials remain on the control plane. Saved model access also powers Velum. Speech remains separately configured.

`GET /v1/account` returns public settings. `PUT /v1/account/{repository,model,onboarding,knowledge,telemetry,people}` requires an authenticated human,
`X-Ephyra-Account` matching that DID, an `Idempotency-Key`, and `expectedVersion`. Cookie writes also require same-origin
browser requests. Keys and repository tokens are encrypted with `EPHYRA_SESSION_KEY`; responses and operation receipts
contain only public settings. Completed receipts are immutable, pending receipts require reconciliation, and versions
prevent concurrent saves from overwriting each other. Save-time model listing performs no billable generation.

Project data is namespaced in Convex, including audit chains, idempotency keys, jobs, usage, runs and drafts. An omitted
workspace means the legacy deployment namespace only. The browser binds every project request with `X-Ephyra-Workspace`;
stale account/repository writes are refused. Changing repository or branch selects a separate namespace and mirror,
preserving previous work. Current account queues resume at boot. Hosted model changes may need another sign-in to grant
the exact inference scope; no fallback model is chosen.

Repository setup resolves a canonical identity before choosing the workspace. Public HTTPS smart Git negotiates SHA-1/SHA-256
and fetches one shallow branch with DNS pinning, disabled redirects/hooks, isolated Git configuration and transient credentials.
Tangled resolves the owner declaration and repository manifest to the exact knot, with credentials bound to that host.
Radicle uses a temporary account-scoped reader profile and foreground node; the bundled CLI is pinned and checksum verified.
Private Radicle identity provisioning remains an explicit host callback, never the operator's ambient profile. Provider HTTPS requests use the same public-destination policy.
Local/private-network endpoints, SSH URLs and dumb HTTP Git are not supported by hosted account setup. Existing
deployment configuration remains available for self-hosted local integrations. Repository fetches have time/output/disk
bounds; disk polling can briefly exceed the configured 512 MB limit.

Verified offline: account ownership and Origin checks, cross-account workspace isolation, scoped Convex persistence,
CAS/idempotent receipts, encryption and credential removal, real local Git fixtures, provider protocol/usage attribution,
and desktop/phone sign-in → optional key → draft → sign-out. Public models.dev metadata and pinned HTTPS transport have
also been read live without credentials. Real account inference, paid settlement, private forge credentials and personal
sandbox execution remain Unverified.

## Not Organic knowledge connections

`GET /v1/account/knowledge` returns the current granted source catalog and setup links. `PUT /v1/account/knowledge`
saves `{ expectedVersion, workspaceId, enabled, sources }`; a source selects `resources` and/or an exact
`searchTool: { name, definitionHash, queryField }`. Enabling with an empty selection is valid and starts the optional
authorization flow. No source or tool is enabled automatically. `/auth/login?setup=1` adds `knowledge:read` and
`knowledge:tools` to the account's selected model scopes. Existing device grants need fresh authorization to expand.

The portal handoff uses the configured portal origin, exact public `app_client`, and a same-origin return link.
Not Organic keeps connection credentials and per-app grants. Ephyra's server calls its configured gateway with that
account's DPoP token; no upstream token or server endpoint is given to the browser, agent or runner. Catalog discovery
does not execute tools. Setup choices follow the first repository; later repository/branch changes clear them.

`NotOrganicEvidence` supplies selected sources to research and reproduction. Listed text resources are read through
the gateway. Eligible research tools must claim read-only operation, have no destructive hint, and accept one supported
string query (`query`, `q`, `search`, `term`, or `text`) with no other required arguments or query constraints. The owner
must grant the tool in Not Organic and explicitly select its exact definition in Ephyra. Annotations alone are not authority.
Changed definitions, local disabling, account/workspace changes or revoked grants block access, including receipt reuse.

Each automatic tool request claims an operation key bound to account, workspace, source, tool definition and the
trail/revision/head/query before dispatch. Completed receipts retain bounded actual text. Pending, failed or ambiguous
operations never automatically dispatch again. Convex uses the workspace ledger; without Convex, private immutable
claim/result files under `knowledge-operations` preserve tool receipts across restarts. Incomplete/corrupt receipts
require reconciliation. This does not make other memory-mode account or workflow stores durable.

Source content and metadata are untrusted evidence, stored with provenance and bounded before entering agent context.
The gateway transport has an eight-second deadline and 1 MiB response bound; adapter reads are independently bounded.
Generic resources without lexical matches may supply a few explicitly labelled fallback documents. This is context,
not proof of causality. No arbitrary MCP action or model-selected URL/argument dispatch is exposed.

Verified offline: DPoP binding, scopes, account/workspace isolation, exact definitions, revocation, interrupted-call
receipts across local restarts, source attribution in the real composed workflow, and onboarding/Settings browser flows
with fixture gateway sources. **Unverified:** live Not Organic knowledge enablement, Ephyra client registration and
authenticated remote MCP behavior. The service must enable knowledge and the owner must grant the exact Ephyra app.

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
| `GET /v1/trails/:id` | The quest, its events, its review documents, its recovery plans (`artefacts/recovery/*`, named by an index the server keeps because a journal cannot list a directory) and `effects`: every effect a transition asked for, with the event that caused it. `effects` records intent, not delivery, and is absent when the history cannot be read |
| `GET /v1/questions`, `GET /v1/questions/:trail/:question` | On a self-hosted server: what a stopped quest is asking and of whom. Any authenticated principal may read |
| `POST /v1/questions/:trail/:question/answer` | On a self-hosted server: only the principal the question was addressed to (its contact's `did`) may answer; anyone else gets 403. The answer is checked before the quest resumes |
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
| `GET /v1/runs/:id/events?after=<seq>` | `AgentRunEvent[]`; SSE includes sequenced `run_event`, changed `run_state` snapshots, and final `end`; `Last-Event-ID` resumes events |
| `POST /v1/runs/:id/policy` | Ingestion for the Amp harness plugin's `tool.call` decisions (service token allowed even with sign-in on) |

Run-state snapshots carry session/portal links while execution is still active, without requiring the reader to reconnect.
Optional saved `AgentRunEvent.visual` presentations use the same authorized storage, replay and membership boundary as the
transcript. Convex appends batch by encoded byte size as well as event count. The console never fetches an arbitrary runner
file or proxies a portal through the authenticated API. The local launcher handle is recorded only for the runner executing
the work; an Amp orb or remote runner keeps its own reported identity. A missing orb ID remains unreported.

**Documents.** `autonomy.md`, `thresholds.yaml` and `intents/<name>.md`. Source order for each: the configured file
(`EPHYRA_AUTONOMY_FILE`, `EPHYRA_THRESHOLDS_FILE`), then the deployment repository at `EPHYRA_BASE_REF`, then the shipped template
(autonomy and thresholds only). The digest is the SHA-256 of the text. Parse errors are reported in `warnings` with an `error:`
prefix and block publishing; other warnings do not. A draft of a new intent starts from an empty document.

**Publishing.** Refused (409) when the draft isn't open, has errors, or the document's digest moved since `baseDigest`. Otherwise it
writes a commit (the base ref's tree with the new file, or a root commit when the base ref doesn't exist) to
`refs/ephyra/policy/<draft-id>` with `Ephyra-Draft:` and `Ephyra-Approver:` trailers, creating the ref with compare-and-swap, appends the
audit entry `policy.publish`, and marks the draft published. A replay after a crash finds the identical commit and reuses it.
Publication does not change the active policy. The separate reviewed activation flow below applies control-plane policy.

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
The server Dockerfile builds this directory in a separate frontend build stage and copies it into the runtime image.
Its frozen dependency install uses `infra/docker/server.bun.lock`, a release lock generated from the workspace manifests.
When dependencies change, regenerate that lock in an isolated checkout (`bun install --lockfile-only`, then copy
`bun.lock` to `infra/docker/server.bun.lock`). This leaves other lanes' local locks alone. The runtime contains only production dependencies.

Console decisions include the reviewed `bound` (revision, head and proof digest). If that binding differs from the
current inbox item, the server refuses it before recording a decision. Trail detail exposes bounded plain-text
`hypothesis.md` and `plan.md` from the matching journal revision, plus the recorded proof events. Missing or moving
journal content is returned as unavailable. No arbitrary file paths are accepted from the console.

**Shared trail reviews.** `comment`, `claim` and `release` use the authenticated principal. Claims
are allowed only at `hypothesised`, `planned` and `ready`; the existing `Trail.owner` records the
reviewer. Only that owner can release. While held, workflow actions and checkpoint/spend decisions
are refused; comments remain available to approvers. This is review ownership, not cancellation of
an active agent. A failed proof ends ownership before normal patching or parking; an owner can release
while already-enqueued proof remains in progress without restarting that work.

These three writes accept an optional `Idempotency-Key` (the console always supplies one). A stable,
principal/trail/action-scoped event ID deduplicates the intent against the durable journal inside the
serialized engine. Changed content under the same key returns 409. A retry repairs a failed projection
from the latest journal state. `GET /v1/trails/:id/operations/:action?key=…` reports `recorded` or
`not_found` for the requesting principal; it never applies a write. Audit records are labelled request
attempts, and comment text is excluded from operational logs and audit payloads. The journal retains
the comment itself. Review bindings are checked again inside the serialized mutation.

Old persisted `handed_off` trails without an owner require operator reconciliation. Ownership is not
invented from those legacy states, whose original takeover could have left active work running.

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
- **Live plugin reporting.** `.amp/plugins/ephyra.ts` now implements the documented plugin API and fixed artifact reporting.
  Its authenticated channel has offline receiving tests; no policy event has been observed from a live Amp run.
  See `.amp/README.md` for the required executor identity verifier. Policy events are never synthesized.
- Landing the published policy commit on Radicle or Tangled (the commit only lands through the forge adapters that are verified), and
  the Convex `drafts`, `runs` and `runEvents` functions against a live deployment.
- Orb and runner repro/patch steps need the installed `ephyra_report` plugin and the configured authenticated report inbox.

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
  A browser login sets a host-only HttpOnly `SameSite=Lax` session cookie and redirects to `/app/`.
  HTTPS uses the `__Host-` cookie prefix and `Secure`; local HTTP uses an unprefixed cookie.
  `GET /auth/session` returns the sign-in availability and current identity, never the credential.
  Cookie-authenticated mutations require the exact configured public Origin. Bearer authentication remains available to the CLI.
  `POST /auth/logout` revokes the session and clears the cookie; session and authenticated API responses bypass caches.
- Terminal: `ephyra login <server-url>` prints a link and a code; the browser page shows the same code and an Approve
  button; the CLI then collects its session once and stores it in `~/.config/ephyra/credentials.json` (mode 600).
  `ephyra whoami`, `ephyra logout`.
- Sessions live in Convex: the session token only as a SHA-256 hash, the Not Organic refresh token and DPoP key
  sealed with AES-256-GCM under `EPHYRA_SESSION_KEY`. Refresh-token rotation is saved with compare-and-swap.
- Changing trails needs a signed-in account listed in `EPHYRA_APPROVER_DIDS`; other signed-in accounts can read.
  Signing in does not grant approver permissions or connect a new repository.
- `EPHYRA_DECIDE=notorganic` / `EPHYRA_EXTRACT=notorganic` run triage on Not Organic judgement and extraction,
  paid from `EPHYRA_BILLING_DID` (default: the first approver), using that account's sign-in session.

**Registration.** Not Organic only signs users into approved client origins. Ephyra's origin is in the gateway's
`PUBLIC_CLIENT_PRODUCT_CATALOG` on the notorganic-provider Railway project, mapped to product `notorganic`, so tokens
carry `product: "notorganic"` (set `NOTORGANIC_PRODUCT` to match). A dedicated `ephyra` product id would need a
release of notorganic-provider (`PRODUCT_IDS` in `packages/contracts/src/catalog.ts`).

## Voice

The optional voice service supplies `GET /v1/voice` and `POST /v1/voice/{transcribe,speak,reply}`. It uses the same
authentication and approver rules as other console writes because speech and replies spend the deployment's account.
The conversation model is the existing `EPHYRA_DRAFT` model. Speech defaults to disabled; the UI reports that state.

| Setting | Purpose |
|---|---|
| `EPHYRA_VOICE=none\|notorganic\|compatible` | Speech provider; default `none` |
| `EPHYRA_VOICE_STT_MODEL` | Explicit transcription model or Not Organic alias |
| `EPHYRA_VOICE_TTS_MODEL` | Explicit synthesis model or Not Organic alias |
| `EPHYRA_VOICE_NAME` | Voice supported by the selected synthesis model |
| `EPHYRA_VOICE_URL` | Compatible service's base URL, including `/v1`; remote services require HTTPS, loopback may use HTTP |
| `EPHYRA_VOICE_API_KEY` | Optional compatible service credential, kept server-side |
| `EPHYRA_VOICE_MAX_COST_MICROUSD` | Not Organic reservation ceiling per speech request; default 100,000 microdollars, not a quoted price |

Not Organic uses the billing account's DPoP-bound sign-in and adds inference scopes for the two selected audio models.
An existing account session may need to sign in again for those scopes. Compatible services implement multipart
`POST audio/transcriptions` (`model`, `file`, `response_format=json`) and JSON `POST audio/speech`
(`model`, `input`, `voice`, `response_format=mp3`). Their model availability and endpoint behavior must be verified
against that deployment. There is no model or voice fallback. Credentials and all URL selection stay on the server.

Every write requires an operation key scoped to the authenticated principal. The existing operation ledger claims it
before dispatch; pending or ambiguous results raise core `ReconciliationRequired`, never an automatic second request.
Restart recovery uses the same ledger (durable with Convex, process-local in memory mode). Completed audio can replay
from the bounded in-memory cache; once gone, the server returns `audio_expired` without synthesizing again. The ledger
stores text results/receipts but no audio bytes. Requests are bounded to 4 MB of input audio, 3,000 speech characters
and 8 MB of returned audio. The browser ends recordings after one minute.

Read-only conversation context is loaded from the selected server resource, bounded, redacted and wrapped in
`untrusted` blocks outside system instructions. It has no action tools. Document voice turns use the existing
draft-message endpoint and proposal validation. Voice never grants approval or publication rights.

Returned identities/prices are recorded exactly. Binary speech normally reports neither; these stay unknown rather
than treating the requested alias as the actual backend or making up a price. Usage rows use the existing `draft`
kind, Velum persona and explicit `voice.*` steps. Configured choices in capabilities are not availability attestations.

Local verification covers adapter requests, replay/concurrency/restart behavior, permission gates, client-to-composed-
server contracts and unknown costs. Live providers, DPoP audio requests, hosted ledger durability and billing remain
unverified. The audio transport and conversation ports are exported from `src/index.ts`.

## Humans& collaboration and tutoring

Velum can use **Ampersand** for clarifying intent, discussing competing requirements and proposing autonomy edits.
The existing JSON proposal/form parser validates its output; a model reply cannot apply or publish anything.
**&Tutor** is a separate, text-only specialist for understanding a recorded trail and the consequences of a checkpoint.
Both can use the console's speech transport. They are not native realtime voice models.

| Setting | Purpose |
|---|---|
| `EPHYRA_DRAFT=ampersand` | Use `ampersand-v0.1` behind Velum, including its spoken draft conversation |
| `EPHYRA_HUMANS_API_KEY` | Server-side Humans& credential for direct Ampersand or Tutor requests |
| `EPHYRA_TUTOR=none\|notorganic\|ampersand` | Tutor provider; default `none`, exact model `ampersand-tutor-v0.1` |
| `EPHYRA_TUTOR_MAX_COST_MICROUSD` | Hosted Tutor reservation ceiling, up to 100,000 microdollars; not a price |

Hosted Tutor uses Not Organic's dedicated `POST /v1/tutor/consult`, the billing account's DPoP credentials and
`infer:ampersand-tutor-v0.1`. Existing account sessions may need to sign in again for that scope. The gateway must have
Tutor enabled. Its consultation service supplies advice, which Ephyra presents as a guide to the supplied evidence.
Ampersand currently uses the direct Humans& adapter; Ephyra does not claim that Not Organic's chat endpoint serves it.
Direct requests are billed to the configured key. There is no fallback between these providers or roles.

`GET /v1/tutor` describes configuration; `POST /v1/tutor/explain` takes an idempotency key and a `TutorInput`. It inherits
the approver gate because it spends the deployment's account. The server loads the trail, verifies its revision, head,
proof digest and update time against the displayed binding, and sends bounded, redacted excerpts outside instructions.
The reply returns those excerpts, the binding, a stale flag and the actual model/usage receipt. Follow-ups carry at most
two recent messages, bounded to a small context excerpt; full history is not a persistent tutoring session. No tutor output
is proof, an approval or an action. `tutor.explain` appears under the existing `study` usage kind and Velum persona.
The current gateway returns token usage but no per-request price; Ephyra keeps cost `null` rather than computing a bill.

The direct adapter implements [Humans&'s Agents API](https://ampersand.humansand.ai/docs/API_REFERENCE.html): isolated
sessions, low reasoning effort, silent completion disabled and no tools/environment access. Creation does not accept an
upstream idempotency key. Ephyra claims its own ledger entry first, saves the observed session ID in the companion
`humans:<operation-hash>:session` entry, and caches the completed result. Incomplete, mismatched or uncertain deliveries
require reconciliation and never create a second session automatically. Closing SSE is not cancellation: Ephyra sends
a best-effort cancel event for a known unfinished session without claiming that cancellation succeeded. Durable replay
requires the Convex ledger; development memory mode loses operations on restart.

Verified with fixtures: protocol framing across byte boundaries, exact model identity, cancellation requests, duplicate
and restart protection, grounding/redaction, stale bindings, spending permissions, client/server contracts and console
interactions. Unverified: live Humans& access, provider quality/latency, actual account settlement, hosted durability and
any improvement in operator understanding. No paid model calls were made during these checks.

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


## Automatic setup and self-driving checkpoints

`GET /v1/setup` reads the current workspace setup; `GET /v1/setup?operationKey=...` reads the exact start receipt.
`POST /v1/setup` accepts `{ "mode": "autonomous" }` (the default) or `supervised`, with an `Idempotency-Key`.
It inherits authentication, same-origin cookie protections and the workspace binding. It returns 202 while the
`automatic_setup` job inspects the pinned repository commit. Starts are serialized with Git ref transactions;
repeating a key cannot start a second run. Reusing a key for a different mode is rejected.

`refs/ephyra/setup/runs/<id>` contains `state.json`, `autonomy.md`, `thresholds.yaml`, `intents/application.md`, and
`ephyra/{verification,evidence,recovery}.json`. `refs/ephyra/setup/current` points to the latest run. These refs stay in
the workspace mirror: setup does not push, change the source branch or deploy. Existing autonomy/intent/calibration
files are retained; supervised mode can narrow checkpoint permissions. Repository scripts are untrusted candidates,
not proof until their sandbox command receipts exist. Generated intent text leaves product-specific intent unverified.

Setup provisions a sandbox and runs discovered package scripts when hosted execution is configured. The observed package
manager, lockfile, command exits/logs/durations, source head and cleanup receipt are retained in `ephyra/provisioning.json`.
Missing tools, missing locks, incomplete commands, empty verification and uncertain cleanup cannot pass. Unsupported
non-JavaScript toolchains need a verification adapter. Existing failures are recorded rather than silently baselined away.

The operator configures `EPHYRA_HOSTED_RUNNER=railway`, `EPHYRA_RAILWAY_TOKEN`, `EPHYRA_RAILWAY_ENVIRONMENT_ID`, and
`EPHYRA_HOSTED_ACCOUNTS` (comma-separated DIDs; `*` explicitly grants all signed-in accounts). Optional
`EPHYRA_RAILWAY_CHECKPOINT` selects a prepared toolchain image; otherwise the SDK's default image is used and actual
missing tools are reported. CPU, memory and idle timeout are configurable with `EPHYRA_RAILWAY_CPU`,
`EPHYRA_RAILWAY_MEMORY_MB`, `EPHYRA_RAILWAY_IDLE_MINUTES` (defaults 1 CPU, 2000 MB, 5 minutes). The provider does not enforce
a disk quota; the profile explicitly records `diskMb: 0`. CPU/memory enforcement and idle timeout are separate from the
server's lease deadline. Cleanup jobs recover from persisted resource IDs and surface uncertain cleanup in operations.
A lost create without an observed provider ID requires reconciliation and never allocates a replacement automatically.

The account coding agent calls its selected model on the server and executes bounded structured actions in the sandbox.
Every model turn and tool action has a durable receipt; unknown outcomes do not replay. Fresh contexts keep the objective,
failed approaches and budget. Git bundles transfer only selected code history and return exact patch commits, without
sending account credentials, remotes or journal refs into the VM. This works with SHA-1 and SHA-256 repositories, including shallow history: transfer metadata carries only reachable
code boundaries, validated and installed before fetch. Unrelated journal refs and objects are excluded.

`investigationActive` can be true while setup is `blocked`: investigation is enabled once the agent, runner, decision
backend and verification baseline are available. Unverified landing/watch capabilities remain explicit blockers and
cannot write through the personal landing handler. A connection or baseline is not proof of production repair.
`workspaceAutomation` remains the adapter injection point for other hosting implementations; no deployment CLI identity
is inherited. Durable workflow queues and account settings require Convex; local file ledgers preserve external-operation
receipts but do not turn development memory mode into a durable deployment.

`checkpointHandlers` evaluates advisory A/B/C checkpoints using the decision backend and calibrated response identity.
It records questions, source documents, answers and decisions under `decisions/`, with `latest-A/B/C.json` available
in the trail inspector. C also validates the pinned proof and actual diff scope. Supervised checkpoints use the human
inbox. Unknown identities, incomplete proof and ambiguous calls cannot approve. Durable provider receipts prevent paid
retries, journal-head checks prevent stale decisions, and comment-triggered reevaluation has a per-revision call limit.
Existing high/critical proof requirements still apply; this change does not remove those policy constraints.

`gatherResearchEvidence` reads configured `EvidenceSource`s before research/reproduction, puts the results into untrusted
prompt data and journals coverage, timestamps and exact source references. `TractionEvidence` implements Traction's
actual `/api/state` contract with a server-configured account/workspace/project allowlist and credential resolver.
Self-hosted deployments can set `EPHYRA_TRACTION_ORIGIN`, `EPHYRA_TRACTION_TOKEN` and a comma-separated
`EPHYRA_TRACTION_PROJECTS` allowlist; personal workspaces never inherit this token. Its aggregate PostHog/service-health
evidence supplies context, not traces or causal proof. Traction's operator token
is broad; a hosted integration must authorize the configured project binding. Global briefings are excluded.

Recovery plans preserve the declared trail budget, prior failure references and attempted hypotheses. Isolated retries
change approach; supported CLI adapters and the account model start fresh contexts. Other adapters seek additional evidence.
One checked factual answer permits one additional isolated attempt; prior failures, uncertain operations and budgets remain intact. Ambiguous external operations do not retry. The planner is not a replacement for provider
metering, hard spend reservations or a production sandbox's enforcement.

Verified with local Git fixtures, fake decision/evidence services and browser flows: persistent setup documents,
idempotent starts, restart recovery, capability blockers, supervised mode, machine A/B/C progression, stale and ambiguous
responses, bounded recovery, source isolation and desktop/phone onboarding. No paid model, production repair, remote
forge landing, live PostHog query or hosted provisioning was performed. Traction's public health endpoint responded,
but authenticated coverage and end-to-end usefulness remain Unverified.


## Shared workspace invitations

The account authority stores optional, server-only membership records beside each account. Owners choose `viewer` or
`approver`, issue a single-use seven-day invitation, and can revoke pending or accepted access. Public team responses
contain labels, actual accepted DIDs, roles, dates and versions; only a hash of the redeemable secret is stored. Stable
operation keys reproduce the original invitation token on replay without creating another grant or restoring revoked access.
Concurrent settings/team changes use the existing memory/Convex version-and-receipt transaction.

Endpoints: `GET /v1/account/team`, `GET /v1/account/workspaces`, and `POST /v1/account/team/{invitations,preview,accept,revoke}`.
Preview is an authenticated read-only POST so secrets never enter request URLs. Account-changing requests require the
signed-in account binding and same-origin guard. Invite/revoke additionally require matching workspace headers and body.
Shared requests resolve current owner records and roles on every request. Viewers cannot mutate; Approvers can use existing
review/draft/spend capabilities, but cannot change owner account settings, team access, or setup. New repository bindings
permanently discard old grants. Open shared SSE streams recheck membership and cancel their producer after revocation.

Verified: local memory and Convex transaction simulation, fake-issuer signed-in HTTP flows, Viewer/Approver boundaries,
expiry, one-time use, idempotent replay, concurrent claims, changed repository bindings, secret non-disclosure, and actual
local SSE teardown. Console browser tests also cover the complete invite/join/revoke flow and shared selection after reload.
Unverified: deployed Convex transactions, hosted identity-provider login, distributed load, and production lifecycle.
Workspace discovery currently scans account records; larger installations should add an indexed membership lookup.
## PostHog investigation and contact routing

`PUT /v1/account/telemetry` accepts the version/workspace binding, `enabled`, exact PostHog `origin`, numeric `projectId`,
write-only `apiKey`, and optional `includeRecordings`. Saving checks read access with a bounded query; it does not claim
that an empty response proves health. Keys are encrypted, bound to the exact origin/project/workspace, and cannot follow
repository changes. The adapter rechecks authority before fetching and before releasing data.

`posthog_poll` jobs query recorded exceptions with a timestamp-plus-UUID cursor, overlap windows and deduplicate immutable
provider event IDs. Only observed exceptions become signals. Queued continuations survive restart on Convex. Research can
read exception details and optional recording metadata/console logs; missing replay, stale computations and unknown
retention remain explicit. Project URLs and fixed read-only SQL come from saved settings, never model instructions.

`PUT /v1/account/people` configures an optional contact roster (`id`, `alias`, roles, areas, optional DID) and authenticated
HTTPS delivery bridge (`webhookUrl`, write-only `token`). The default is the workspace owner inbox; no contact setup is
required. Other recipients require the configured bridge. The model chooses from that roster and drafts one targeted
factual question per code revision. A separately checked decision, keyed by exact backend identity, must accept its
necessity and recipient before dispatch. Questions never ask for new permissions or spending authority.

The bridge receives `ephyra.investigation.question`, a stable idempotency key, configured recipient ID, question, reason,
acceptance criterion and seven-day `/answer#<capability>` link. It routes the message through the operator's existing
messaging system. The capability stays out of request URLs/logs and is bound to account/workspace/trail/question/recipient.
Non-acknowledged delivery remains uncertain and is never sent again automatically. A valid recipient reply can confirm
such a delivery. Reassigning the contact or changing workspaces revokes the old link.

`GET /v1/questions` lists current questions; `GET /v1/questions/:trail/:question` reads the exact operation record for
reconciliation; owner inbox replies use `POST /v1/questions/:trail/:question/answer`. `questions/<id>.json` and
`questions/latest.json` retain the checks, exact models, delivery state and answer in git. Accepted answers resume only
the same parked code revision and are supplied as untrusted evidence. Unknown outcomes and rejected answers remain
inspectable. No answer changes policy, budgets or proof requirements.

Verified offline: scoped PostHog queries/paging/revocation, ingestion dedupe across file-ledger restarts, native forge
metadata and SHA-256 imports, hosted SDK contracts, real local account-agent patch/bundle transfer, provisioned setup
receipts, checked questions/answers, uncertain delivery, HTTP account isolation and browser flows. Live paid Railway
allocation, authenticated native transport, real PostHog projects, message bridges, remote landing and production repair
remain Unverified; none was exercised or deployed by this implementation pass.

Hosted proof prepares both base and head worktrees from the observed package-manager/lockfile baseline, installs
locked dependencies with operation receipts, and uses the selected recorded test script. Bun, Cargo, TAP/node:test,
Jest and Vitest reports require consistent actual counts and failure identities; unsupported or ambiguous reports
remain Unverified. A proof integration failure parks the trail instead of allocating another sandbox blindly.


## Completing the repair loop

Personal HTTPS Git workspaces now use `RemoteGitAdapter` through the same constrained connector as onboarding.
Every read/write rechecks account and workspace ownership, pins fresh public DNS, disables ambient Git credentials
and hooks, and binds credentials to the connected host. Only the selected branch or the trail's own branch may be
written; writes require an exact lease. The selected production branch cannot be deleted. A successful remote readback
is required for a landing receipt. Lost writes require reconciliation and never automatically push again.
Native proposal adapters require explicit account-scoped signing/RPC hooks; see `packages/forge/README.md`.
Withdrawing a proposal is distinct from reverting code which has already deployed.

The optional PostHog connection now accepts `deploymentUrl`. Its public HTTPS JSON endpoint must return:

```json
{
  "schema": 1,
  "repository": "https://git.example.org/team/application.git",
  "branch": "main",
  "commit": "<full 40- or 64-character Git object ID>",
  "deployedAt": "2026-11-08T12:00:00.000Z"
}
```

Repository and branch must exactly match the saved connection. The URL has no embedded credentials, query or
fragment; only this explicitly selected source is read. A different commit means the deployment is still pending.
The endpoint is an operator-owned observation, not an Ephyra deployment mechanism or independent attestation.

Before a write, watch preparation measures attributable route error rates and records configured probes. No-route
error rates are explicitly inapplicable, not a guessed baseline. Every watch sample rechecks fresh scoped telemetry
coverage, exact deployed code and probe results. Missing attribution or partial/stale telemetry is a recorded gap and
cannot close a trail. The window begins at the recorded deployment time, or the first attributable observation when
a custom deployment adapter has no activation timestamp. Persistent missing coverage parks the watch.
`ComposeOverrides.landing` supplies equivalent scoped ports for other hosting integrations.

`ProofOptions.collectEvidence` runs inside both prepared revision worktrees. The composed server executes the current
repro again as seed regression coverage, applicable historical regression scripts, accepted intent scripts and an
actual review turn. Closed trails register the original, proof-bound repro script in immutable Git refs. Intent
definitions come from the accepted base or an explicitly activated policy, so a patch cannot weaken its own intent.
A script intent uses the design's YAML frontmatter, for example:

```yaml
---
id: checkout-total
area: application
paths: ["src/cart/**"]
probes:
  - id: preserves-total
    kind: script
    command: ["bun", "run", "probe:checkout-total"]
---
Checkout preserves the recorded item total.
```

Accepted `.ephyra/proof.json` configuration can select actual UI/replay reporter commands:

```json
{"schema":1,"commands":[{"id":"stories","command":["bun","run","proof:stories"],"protectedPaths":["package.json","bun.lock","proof/**"],"kinds":["story_render","story_interaction"]}]}
```

The command receives `EPHYRA_PROOF_TRAIL`, `EPHYRA_PROOF_REV`, `EPHYRA_PROOF_BASE` and `EPHYRA_PROOF_HEAD`.
It must exit normally and return JSON `{schema:1,trailId,rev,base,head,items}` with exact bindings and only its declared
evidence kinds. Declare the complete verifier harness/dependency closure in accepted-base `protectedPaths` (also
supported on script intents). Candidate changes to that closure, including worktree changes made by tests, invalidate
the verifier. Mutable external harness commands without a declaration fail closed. Application paths under test
must stay separate from the trusted harness; an empty or incomplete declaration does not establish trustworthy proof.
Persona studies, real respondent studies and visual approvals come through host-authorized
`verification.sources` with exact revision/provider-operation receipts. They cannot be manufactured by reporter output.
`respondents` is the separately spend-approved provider hook. Missing evidence parks explicitly instead of repeatedly
repatching; an empty catalog, generated intent prose or a successful connection is never passing proof. Script intents
are supported; other declared intent probe kinds require an execution adapter and fail closed.

High/critical automated evidence can reach checkpoint C with `awaitingHumanC: true`. This records an outstanding
named-human decision instead of pretending one already happened. High/critical C cannot be approved by policy;
critical changes cannot use automatic or live landing. Final evaluation still requires the actual human decision.

### Runtime controls and budgets

`usage_recorded` events charge actual reported inference usage to the Git-backed trail, keyed by stable operation IDs.
Account models report each completion before interpreting its products, including failed steps. Unknown costs/tokens
remain explicit counters; personal workspaces stop when a required cost is unknown. Executed wall time accumulates
across agent, proof and standalone probe runs; waiting at checkpoints does not consume execution time.

| Variable | Default | Meaning |
|---|---|---|
| `EPHYRA_TRAIL_TOKENS` | 2000000 | Cumulative reported token allowance |
| `EPHYRA_TRAIL_WALLCLOCK_S` | 14400 | Cumulative execution-time allowance |
| `EPHYRA_TRAIL_SPEND_MICROUSD` | 0 | Explicit metered inference allowance; zero grants no paid account turn |
| `EPHYRA_REQUIRE_KNOWN_COST` | false | Require reconciled costs in deployment workspaces; personal workspaces always require them |

The hosted account request passes its remaining monetary ceiling to Not Organic's existing reservation header.
CLI providers cannot enforce hard token or monetary limits which their interfaces do not expose; returned usage is
charged after execution. Unknown settlement blocks the personal workflow rather than being treated as free.
These inference counters do not establish Railway billing or cap external resource spend. Host resource grants,
leases and cleanup receipts remain separate controls.

Killing aborts active control-plane calls and tears down actual runner handles. Late allocations are destroyed before
work can begin. Stop receipts distinguish confirmed destruction, pending allocation and uncertain cleanup. Queued jobs
and returned outputs check state, code, policy and work generation; parked/resumed work cannot accept an old result.
A moved base schedules a real patch/rebase attempt, and bundles include exactly the old head and new base histories.

### Explicit policy activation

`GET /v1/policy/active` returns the validated active receipt or null.
`POST /v1/drafts/:id/activate` requires an approver, an `Idempotency-Key` and:

```json
{"expectedCommit":"<published commit>","expectedDigest":"<content SHA-256>","expectedActive":null}
```

After the first activation, `expectedActive` is the current activation commit. The service atomically creates the
operation receipt and advances `refs/ephyra/policy/active`, validates all effective documents, audits the approver and
reloads policy. Replay never rolls back a later activation. Restart/setup recovery reloads the durable active override.
New policy invalidates unfinished work and old C approval, recomputes affected area/risk, and requires resuming under
the reviewed policy. Already authorized landing/watch operations retain their recorded policy. The console exposes
a separate activation confirmation and preserves an uncertain operation key for read-only reconciliation.

Offline integration tests cover a real medium-risk local repair, actual commands/review, explicitly labelled study
fixtures, conditional bare-Git remote writes, deployment/telemetry gates, regression registration/reuse and rollback.
These offline tests do not exercise a live paid provider, native forge, Railway allocation or production repair.
Actual intent, study receipts, executor identity verification and deployment observations remain required inputs.

### Configured external study evidence

The shipped executable supports two receipt transports. Set both `EPHYRA_PROOF_RECEIPTS_DIR` and
`EPHYRA_PROOF_TRUST_FILE` to absolute operator-owned paths outside all candidate worktrees. The trust file is rechecked
on every receipt read, including after restart. Repository policy and account settings cannot add source grants.

```json
{"schema":1,"grants":[{"sourceId":"study-service","workspaces":["<exact workspace ID>"],
"kinds":["persona_study","voxq_study","visual_approval"],"transport":"signed",
"publicKey":"<Ed25519 SPKI PEM public key>"}]}
```

Choose `transport: "directory"` and omit `publicKey` to import an operator-verified export, or choose `signed` for
provider automation. Directory receipts cannot be submitted over HTTP. Signed providers POST to `/callbacks/proof`:

```json
{"receipt":{"schema":1,"sourceId":"study-service","workspaceId":"<exact workspace ID>",
"trailId":"<UUID>","rev":1,"base":"<full SHA>","head":"<full SHA>","operationKey":"<actual provider operation>",
"observedAt":"<ISO time>","expiresAt":"<ISO time>","items":["<actual ProofItem objects>"]},
"signature":"<base64url Ed25519 signature of UTF-8 canonicalJson(receipt)>"}
```

Use exported `proofReceiptPath(directory, receipt)` to place a directory envelope (`{"receipt": ...}` without signature).
Receipts are immutable by source, operation and exact revision. Conflicting responses, symlinks, revoked grants, expired
observations, unauthorized evidence kinds, missing run IDs and empty reports are rejected. A synthetic persona stays
synthetic; human studies need actual respondents and actual spending. These transports import completed evidence;
they do not dispatch studies or grant paid execution. Missing required source grants appear in setup's blockers;
configured grants still require a completed receipt for each patch. Offline tests use labelled fixtures and real
Ed25519 signatures, not live study results.

### Worker ownership and recovery

Convex workspaces have one active worker lease with a fencing generation and heartbeats. A second process can serve
reads and enqueue work, but cannot claim jobs, mutate trail projections, write transcripts or apply trail actions.
Lease loss stops jobs, polling and active runner handles. Jobs from an expired or unknown owner are dead-lettered for
reconciliation; startup never repeats an uncertain VM allocation, provider call or remote write.

Every new journal transition atomically stores its pending effects in `outbox/pending.json`. After acquisition the
worker repairs projections from all Git journals, reloads reviewed policy, and delivers only current, never-started
effects. The durable operation ledger preserves completed and ambiguous outcomes. Old journals without an outbox do
not acquire invented historical actions. A running operation that lost its owner still requires reconciliation.

### Release scope and decisions that remain external

| Integration | Usable option | Alternative | Still required |
|---|---|---|---|
| Study evidence | Operator-verified directory export | Signed Ed25519 provider callback | Actual completed studies and explicit workspace/source grants |
| Execution | Account-model agent with granted Railway sandbox | Self-hosted CLI agent in an operator-provided image | Named accounts, credentials, resource allowance and explicit inference budget |
| Remote landing | Account-scoped conditional HTTPS Git | Native Radicle/Tangled adapters through a custom host | Native signing/service-auth ports and a verified deployment observer |
| Amp | Local CLI installed in the runner image | Remote executor plus the authenticated report plugin/inbox | Documented issuer/audience/thread claims and a configured verifier; stock main does not guess them |

Native proposal adapters and remote Amp reports are library integrations. Stock hosted startup does not advertise them
as available. Non-script intent probe kinds still fail `Unverified` until an execution adapter is supplied. Automatic
study dispatch needs a host `respondents` port plus a named, bounded spend approval. No provider account, spend limit or
hosted runner grant is chosen by deployment. An unconfigured deployment remains available for sign-in and setup with
explicit blockers. Configured presence alone does not prove a live repair, payment, cleanup or native write.

Before a release, compare the working branch with the currently deployed revision and the other active product branches.
Merge the console/landing work and runtime work into one history; a healthy server built from a divergent branch can still
remove the interface, invitations, presentation, or newer runtime capabilities. Keep the shared source branch fast-forwarded
to that combined history. Preserve unrelated local files. The 2026-11-08 recovery combines `ui/jakub-console-polish`
and `feat/self-driving-setup`; neither older branch tip is a complete release on its own.

To prepare a release, commit the intended source, then run `bun infra/docker/prepare-server-release.ts`.
It exports exactly `HEAD` into a temporary directory, excludes all dirty/untracked files, writes a credential-free
release manifest, and stamps `ephyra-release.json` in that export. Upload its reported `source` directory with the pinned
Railway CLI to the existing server service and production environment. `/healthz` returns the exact exported revision
with `Cache-Control: no-store`; a development checkout returns null. Both the original Git archive and the exact
deployable payload (including its revision marker) have SHA-256 checksums. These and the previous Railway
deployment ID are the release/rollback evidence. Deploy additive Convex functions/schema before the matching server.
Use the currently configured `EPHYRA_PUBLIC_ORIGIN` for verification; local IaC may lag a separately authorized domain
change. A healthy deployment verifies startup and HTTP routes, not an account's paid repair or browser workflow.
Release the web service from the same export with `infra/docker/Dockerfile.web`. Check `/docs`, `/auth.md`,
`/e/presentation/`, the nine quest moments and six workspace views. The public walkthrough uses the separately built
same-origin console at `/e/app/walkthrough.html`; its inline frame leaves scrolling to the page and its details dialog
provides interaction. `apps/console/scripts/landing-scroll.probe.js` and `landing-workspace.probe.js` cover those boundaries.
