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
| `EPHYRA_AGENT` | `none` (default), `claude-code`, `codex` (the CLI must be in the image) |

## Deploying to Railway

Infrastructure is `.railway/railway.ts` (server, self-hosted Convex with its own volume). Use the CLI pinned
in `.railway/node_modules/.bin/railway`.

1. `railway config plan` then `railway config apply`.
2. Secrets, once: `INSTANCE_SECRET` on `convex`; `EPHYRA_CONVEX_SECRET` and `EPHYRA_API_TOKEN` on `server`.
3. Admin key: `docker run --rm --entrypoint ./generate_key <convex image> ephyra "$INSTANCE_SECRET"`.
4. Functions: in `apps/server`, `CONVEX_SELF_HOSTED_URL=<convex url> CONVEX_SELF_HOSTED_ADMIN_KEY=<key> bunx convex deploy`,
   then `bunx convex env set EPHYRA_CONVEX_SECRET <secret>`.
5. Server: `railway up --service server`.

## Tests

`bun test apps/server`: unit tests, Convex function tests (convex-test), and an end-to-end test that drives
an OTLP error through triage, agent steps, real proof, three HTTP approvals, landing, the watch and a
rollback. Run it against a live Convex with `EPHYRA_E2E_CONVEX=1 CONVEX_URL=… EPHYRA_CONVEX_SECRET=…`.
