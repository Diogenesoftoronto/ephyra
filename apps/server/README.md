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
their implementation. The public marketing site is separate; there is no browser dashboard yet.
