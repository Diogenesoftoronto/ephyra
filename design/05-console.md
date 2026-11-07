# 05 · The console

Status: contract for the first web application people use day to day. Written 7 November 2026. The shared types live in `packages/core/src/console.ts`; this document explains them and fixes the HTTP API, the generative-UI catalog and who builds what.

The console is a React application. The terminal inbox (`ephyra inbox`) stays. The console is the same control plane in a browser, plus two things the terminal can't do well: **seeing what the agents spend and do**, and **drafting policy with an agent**.

## Personas

A persona is a role in the loop, not a model. The engine that plays it is recorded exactly as returned, so every number can be read by persona *and* by engine. The names come from the immortal jellyfish on the home page (cut E).

| Persona | Role | Does | Namesake |
|---|---|---|---|
| **Rho** | Listener | extract, triage | rhopalium, the sense organ |
| **Bell** | Researcher | research, evidence | the bell, the body that carries everything |
| **Nema** | Prover | repro, proof | nematocyst, the cell that stings to test |
| **Lappet** | Mender | plan, patch, review | lappet, the soft flap at the bell's edge |
| **Turri** | Watcher | land, watch, rollback | *Turritopsis*, the jellyfish that turns back time |
| **Velum** | Scribe | draft | velum, the membrane that shapes the flow |

Each persona has a colour token (`--persona-<id>`), a still avatar and a short loop. Assets live in `apps/console/public/personas/<id>.{webp,gif,webm,mp4}`, with the full character brief in `design/brand/PERSONAS.md`. Personas speak plainly. Velum is the only one you chat with; the others report.

## Screens

1. **Overview:** what is running now (activity feed with elapsed time), what is waiting for you (inbox count, checkpoints), and spend this week against budget.
2. **Usage:** totals, spend by day, by persona, by engine and by trail; trail budgets as used/max; a row-level ledger with filters. Unknown costs are shown as "unknown" with a count, never folded into totals as $0. Failed and unavailable work is visible.
3. **Inbox and trails:** the terminal inbox in a browser: checkpoint cards bound to revision, head and proof digest; approve, revise, reject, comment, claim, park; the trail timeline with evidence links.
4. **Workspace:** policy documents (`autonomy.md`, `thresholds.yaml`, `intents/*.md`). Open a draft, chat with Velum, edit in forms that Velum generates or in plain text, see warnings and a diff, and publish (approvers only).
5. **Personas:** who does what, their recent work and spend.

## HTTP API (server)

All routes need the same auth as today (session token or service token + principal). Mutations need an approver when sign-in is on. Every response is validated with the core schemas before it is sent.

| Route | Returns |
|---|---|
| `GET /v1/personas` | `Persona[]` |
| `GET /v1/usage?from&to&persona&engine&trail` | `UsageSummary` (default window: last 7 days) |
| `GET /v1/usage/entries?from&to&persona&engine&trail&cursor&limit` | `{ entries: UsageEntry[], cursor?: string }` |
| `GET /v1/activity?limit` | `ActivityItem[]`, running first, then newest |
| `GET /v1/docs` | `PolicyDoc[]` |
| `GET /v1/docs/:path` | `PolicyDoc` |
| `POST /v1/drafts` `{ path }` | `Draft` (new, based on the current digest) |
| `GET /v1/drafts?status` / `GET /v1/drafts/:id` | `Draft[]` / `Draft` |
| `POST /v1/drafts/:id/messages` `{ text }` | `Draft` with the human message and Velum's reply appended |
| `PUT /v1/drafts/:id/content` `{ content, baseDigest }` | `Draft` (manual edit or a form apply; re-parsed for warnings) |
| `POST /v1/drafts/:id/apply` `{ messageId }` | `Draft` with that message's proposal as the content |
| `POST /v1/drafts/:id/publish` | `Draft` with `published` set; 409 if the document changed since `baseDigest` or the content has errors |
| `POST /v1/drafts/:id/discard` | `Draft` |

### Usage recording

Every unit of work writes one `UsageEntry` with a stable idempotency key:

- model calls (extract, triage) from the existing `UsageHook` in `@ephyra/models`;
- each agent step from `AgentResult.usage` and the step's wall time, including failed and unavailable steps;
- proof runs and sandbox time;
- Velum's draft replies;
- approved voxq studies.

`billedTo` says who pays: Not Organic (hosted, billing DID), BYOK, local (self-hosted or a local CLI), or unknown.

### Publishing a draft

Publishing never edits the live policy in place. It:
1. re-parses the content and refuses on errors;
2. checks `baseDigest` against the current document (409 if it moved);
3. writes a commit with the new file to `refs/ephyra/policy/<draft-id>` in the deployment's repository, with an `Ephyra-Draft: <id>` trailer and the approver's DID;
4. records an audit entry.

The policy in effect changes only when that commit lands on the base ref, through the same forge landing as trails. Landing on Radicle and Tangled stays `Unverified` until those adapters are verified live.

## Velum and generative UI (json-render)

Velum replies with text, an optional **proposal** (the full new document, re-parsed for warnings), and an optional **json-render spec** that renders a form for the part under discussion: "add an area for billing", "make C blocking for payments".

- **Catalog:** `packages/genui` defines it with `@json-render/core` and the standard React schema (`@json-render/react/schema`, which has no React runtime dependency). Components are domain-specific: `Section`, `TextField`, `PathList` (globs), `RiskSelect`, `CheckpointMatrix` (A/B/C advisory or blocking), `LandingModes`, `Duration`, `BudgetField`, `Toggle`, `Note` and `DiffPreview`. Actions are only `apply_to_draft`, `ask_velum` and `discard`.
- **Who uses it:** the server uses `catalog.prompt()` to tell Velum what it may build, and validates every spec against the catalog before storing it. The console implements the registry in React.
- **Specs are untrusted output.** Invalid specs are dropped with a note, never rendered. Applying a form goes through `renderAutonomy` → `parseAutonomy`, so a form can never produce a policy the parser rejects.
- **Models:** Velum runs on a `DraftModel` port:
  - Not Organic's OpenAI-compatible `/v1/chat/completions` on the billing account (hosted);
  - an Anthropic or OpenAI key (BYOK);
  - a deterministic fake for tests and Storybook.
  
  An unavailable model is an `Unverified` error shown in the chat, never a made-up reply.
- **Optional:** compose forms from candidates with json-render's `experimental_composeSpec`, using Jev through Ephyra's TypeSafe adapter as a custom evaluator.

The document text Velum receives is trusted policy. Forge comments or signal text quoted into a draft are untrusted, and go to the model wrapped as `<untrusted_…>` data.

## Packages and boundaries

- `packages/core`: `console.ts` (this contract). Done.
- `packages/policy`: add `renderAutonomy(policy) → markdown`, with a property test that `parseAutonomy(renderAutonomy(p))` round-trips.
- `packages/genui` (new): the catalog. Depends on `core`, `zod`, `@json-render/core` and `@json-render/react`; imports only `@json-render/react/schema`.
- `apps/server`: usage ledger (memory + Convex `usage` table), activity, docs, drafts, `DraftModel` adapters and Velum. It also serves the built console at `/app/`.
- `apps/console` (new): React 19 + Vite SPA, with Storybook (`@storybook/react-vite`) as the single component catalogue. That includes the server's sign-in views, rendered from their HTML. It talks to the server over HTTP only and imports `core` and `genui` for types and the catalog.

Boundary map (`test/boundaries.test.ts`): `packages/genui` → `core`; `apps/console` → `core`, `genui`; `apps/server` may also import `genui`.

## Storybook rule

Every component in `apps/console/src/components/**` and every page has a `*.stories.tsx` with deterministic fictional fixtures (no network, no live auth). A test fails if a component file has no stories. Interactive states (typing to Velum, applying a form, approving a checkpoint, empty and error states, unknown-cost rows) are stories, not screenshots.

## Revision 7 November 2026: assistant-ui, live runs, and the application map

**Stack.** The whole console is React 19 + Vite + TypeScript. Every conversational or agent-transcript surface uses **assistant-ui** (`@assistant-ui/react`, pinned exact, with `@assistant-ui/react-markdown`) through an `ExternalStoreRuntime` adapter over Ephyra's own data. No assistant-ui cloud, no direct model calls from the browser. json-render specs render inside assistant-ui messages as generative-UI parts.

**Live runs (the pluggable harness).** Each agent step is an `AgentRun` with a stream of `AgentRunEvent`s (types in `packages/core/src/console.ts`): messages, reasoning, tool calls and results, plugin policy decisions, status and portal links. Amp runs come from its stream-json (`parseAmpStream` in `packages/agent/src/amp.ts`), which is Claude Code compatible, so Claude Code uses the same normalizer; Codex JSON maps to the same events. The executor says where it ran: an Amp **orb**, an Amp **runner** on your own box, a local process, a Railway or Not Organic sandbox, with the orb or sandbox id, the Amp thread URL and the live portal URL when known. Policy decisions come from the Ephyra harness plugin (design/03 §plugin: `tool.call` allow/reject/modify) and show inline in the transcript.

| Route | Returns |
|---|---|
| `GET /v1/runs?trail&status&limit` | `AgentRun[]`, running first |
| `GET /v1/runs/:id` | `AgentRun` |
| `GET /v1/runs/:id/events?after=<seq>` | `AgentRunEvent[]`; with `Accept: text/event-stream`, a live SSE stream that resumes from `after` |

Screens: **Runs** (all running and recent agent runs across orbs and sandboxes, filter by trail, persona, executor) and a **Run view** that renders the event stream as an assistant-ui thread (read-only, with tool calls as collapsible tool UIs, policy decisions as badges, portal link and "open in Amp" when present). Trail detail embeds its runs.

**The application map (drafting at a higher level).** The Workspace opens on a map of your application, not on markdown. Each area is an `AreaSketch`: a plain-language intent, paths, risk, whether it is user-facing, and an autonomy level on a five-step ladder (Watch, Research, Propose, Patch, Auto-land; `AUTONOMY_LEVELS`). The policy package maps levels to concrete checkpoints, landing modes and watch windows (`sketchToArea` / `areaToSketch`, round-trip tested), and `renderAutonomy` produces the document. You can:

- edit areas as cards (level slider, risk, paths, intent);
- ask Velum in plain language ("payments should never land without me; the marketing site can fix itself") and get a proposal with `sketches`, shown as a before/after map;
- drop into the generated markdown or the threshold and intent documents for detail.

Publishing is unchanged: a commit to `refs/ephyra/policy/<draft-id>`, never a hot swap.
