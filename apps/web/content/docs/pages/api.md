---
title: The HTTP API
summary: The routes the console and CLI use, how to authenticate, and the rules for writes. Build your own tooling on it.
---

The console, the CLI and the terminal inbox are all clients of one HTTP API on your Ephyra server. If you want a dashboard, a chat integration or a CI gate, use the same routes.

The base address is your server's origin, shown here as `{{api}}`. It is separate from this documentation site.

## Authentication

There are three kinds of caller.

| Caller | Sends | Can |
|---|---|---|
| **A signed-in person** | `Authorization: Bearer <session token>` (the CLI's, from `ephyra login`), or the browser session cookie | Read, and decide if they are an approver. |
| **The service token** | `Authorization: Bearer $EPHYRA_API_TOKEN` and `X-Ephyra-Principal: <name>` | Read. Write only while sign-in is not configured. |
| **A coding agent** | A bearer credential obtained through [`auth.md`](./agent-setup) | The `/v1/agent/*` routes within its scopes. |

```sh
curl -H "Authorization: Bearer $EPHYRA_API_TOKEN" \
     -H "X-Ephyra-Principal: ci" \
     {{api}}/v1/trails
```

Once sign-in is configured, every mutating `/v1` route requires a signed-in person on the approver list. The service token is then refused with `403` on writes, with one exception: the harness plugin inside an agent run reports its policy decisions with it.

## Rules for writes

- **Send an `Idempotency-Key`.** A stable key makes a repeated request the same operation instead of a second one. Characters allowed: letters, digits, `.`, `_`, `:`, `-`.
- **Bind decisions.** A decision carries the `bound` object from the inbox item it answers. If the quest has moved on, the server answers `409`.
- **Do not retry an unknown outcome.** If a write times out, read the quest (or the operation receipt) to see whether it was applied before you send it again.
- **Account writes bind to the account.** They carry the current workspace (`X-Ephyra-Workspace`) and a version, and answer `409` when either has changed.

## Quests

In paths and JSON a quest is a `trail`.

| Route | Purpose |
|---|---|
| `GET /v1/trails` | Every quest. `?state=<state>` filters. |
| `GET /v1/trails/:id` | One quest, its events, and the effects each transition asked for. |
| `GET /v1/trails/:id/file?path=` | A file from the quest's journal. Only an allow-list of paths is readable. |
| `GET /v1/inbox` | What is waiting on a person. |
| `POST /v1/trails/:id/decide` | Answer a checkpoint: `{ "checkpoint": "A", "verdict": "approve", "note": "…", "bound": { … } }`. |
| `POST /v1/spend/:id/decide` | Answer a spend request: `{ "verdict": "approve" }`. |
| `POST /v1/trails/:id/comment` | `{ "text": "…" }` |
| `POST /v1/trails/:id/claim` · `release` · `park` · `resume` · `land` | `{}` |
| `POST /v1/trails/:id/kill` | `{ "reason": "…" }` |
| `GET /v1/trails/:id/operations/:action?key=` | Whether a `comment`, `claim` or `release` with that key was recorded. |

Readable journal paths: `hypothesis.md`, `plan.md`, `intent.md`, `evidence/index.json`, `proof/manifest.json`, `artefacts/<kind>/<name>`, `decisions/latest-A.json` (or `B`, `C`), and research evidence indexes. Files over 256 KB are refused, not truncated, so nobody judges half a document.

## Activity, runs and usage

| Route | Purpose |
|---|---|
| `GET /v1/activity?limit=` | What agents are doing and did recently. |
| `GET /v1/runs?trail=&status=&limit=` | Agent runs. |
| `GET /v1/runs/:id` | One run. |
| `GET /v1/runs/:id/events?after=<seq>` | A page of a run's events. With `Accept: text/event-stream` it streams, and resumes from `Last-Event-ID`. |
| `GET /v1/usage?from=&to=` | Totals and breakdowns. Seven days by default, 366 at most. |
| `GET /v1/usage/entries?limit=&cursor=` | The ledger, paginated. |
| `GET /v1/personas` | The six roles. |

## Policy

| Route | Purpose |
|---|---|
| `GET /v1/policy/active` | The active policy receipt, or `null`. |
| `GET /v1/docs` · `GET /v1/docs/:path` | Policy documents, with digests and warnings. |
| `POST /v1/drafts` · `GET /v1/drafts` · `GET /v1/drafts/:id` | Create and read drafts. |
| `PUT /v1/drafts/:id/content` · `PUT /v1/drafts/:id/sketches` | Edit the text or the application map. Send the `baseDigest` you edited from. |
| `POST /v1/drafts/:id/publish` | Write the draft to a policy ref. Approvers only. |
| `POST /v1/drafts/:id/activate` | Put a published draft into effect. Needs an `Idempotency-Key` and the expected commit, digest and currently active version. |

`/v1/docs` here means policy documents. It is unrelated to this documentation site.

## Setup and account

| Route | Purpose |
|---|---|
| `GET /v1/me` | Who the API thinks you are, and whether you can approve. |
| `GET /v1/setup` · `POST /v1/setup` | Read the recorded setup, or start one (`{ "mode": "supervised" }`). |
| `GET /v1/account` | Account settings and connections. Signed-in person only. |
| `GET /v1/account/agents` · `DELETE /v1/account/agents/:id` | Agents you approved; revoke one. |
| `GET /v1/questions` · `POST /v1/questions/:trail/:question/answer` | Investigation questions and answers. |

## Operations and intake

| Route | Purpose |
|---|---|
| `GET /healthz` | Unauthenticated. Store health, mode, version and release revision. `503` when the store is unavailable. |
| `GET /v1/ops` | Worker ownership, dead-lettered jobs and effects needing reconciliation. |
| `POST /otlp/v1/logs` · `POST /otlp/v1/traces` | OTLP/HTTP JSON intake, authenticated with the service token. Protobuf answers `415`. |
| `POST /callbacks/proof` | Signed [study receipts](./study-evidence). |

## Status codes

| Code | Meaning | What to do |
|---|---|---|
| `400` | The body or a parameter is invalid. | Fix the request. |
| `401` | No valid credential. | Sign in again. |
| `403` | Signed in, but not allowed: read-only, or not an approver. | Ask the workspace owner. |
| `404` | No such quest, run or file. | Check the id. |
| `409` | Stale: the quest, workspace or version changed. | Read again, then decide again. |
| `413` | The journal file is too large to serve. | Read it from Git. |
| `501` | This deployment does not support the route. | Nothing to retry. |
| `503` / `504` | Unavailable, or the outcome is uncertain. | Read the recorded status before repeating a write. |

## Stability

The API is pre-alpha and can change between releases. The shapes are defined as schemas in `packages/core/src` (`schemas.ts`, `console.ts`, `events.ts`), which are the reference.

## Next

- [The CLI, which wraps most of this](./cli)
- [What a quest's events mean](./lifecycle)
