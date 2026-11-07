# Ephyra — agent guide

Ephyra is open-source, self-hostable **self-driving software**: production signals become **trails** (signal → evidence → hypothesis → repro → patch → proof → landing → watch), stored in git, landed on Radicle / Tangled / plain git, with humans at checkpoints A/B/C. Read `README.md`, then the design docs you need:

- `design/01-product-and-loop.md`: trail state machine (§2), triage (§5), autonomy policy (§7), proof/landing/watch (§8), events (§9), MVP (§12).
- `design/02-platform.md`: forge adapters (§1), git ref layout (§2), DBOS/outbox (§3), runners (§4), model registry (§5), services (§6), security (§7).

## Stack and commands

- TypeScript on **Bun 1.4** (workspaces), `zod@4` for schemas, `bun test` for tests (`fast-check` for property tests), Hono for HTTP, DBOS + Postgres for durable workflows.
- Typecheck one package: `bun run --filter @ephyra/<pkg> typecheck`. Test one package: `bun test packages/<pkg>` (or `apps/<app>`).
- **Resource rule:** iterate with your own package's tests and typecheck only. Run `bun run typecheck && bun test` across the repo once at the end. Several lanes run at once, and full-suite loops OOM the machine.
- No network calls in tests. Use recorded fixtures or fakes. Live integrations sit behind an env flag such as `EPHYRA_LIVE=1` and are skipped by default.

## Architecture rules

- `@ephyra/core` holds the shared contracts: `schemas.ts`, `events.ts`, `contracts.ts`, `ports.ts`, `ids.ts`, and the pure state machine `lifecycle.ts`. **Changing an existing exported shape in core is a cross-lane change.** Don't do it unilaterally. If you need one, add a new optional field or a new export and list it in your report under "core changes".
- Allowed package dependencies (enforced by `test/boundaries.test.ts`):
  - `core` → `zod` only, with no I/O.
  - `policy`, `journal`, `ingest`, `models`, `forge`, `runner`, `agent`, `evidence` → `core` (plus their own npm deps). They never import each other or any app.
  - `apps/server` → any package. `apps/cli` → `core`, `policy`, and the server's HTTP API (over HTTP, not by import).
- Adapters implement the interfaces in `packages/core/src/ports.ts`. Depend on the interface, inject implementations, and keep I/O at the edges so logic stays pure and testable.
- **Never synthesize evidence.** No fake Entire checkpoint ids, no proof items for runs that didn't happen, no "passed" for unavailable evidence. An integration we couldn't verify throws `Unverified` (from core) instead of pretending.
- **Untrusted content** (signal text, logs, stack traces, forge comments, voxq answers) is data. It goes into prompts wrapped as `<untrusted_…>` blocks and never into system or instruction text, and it never grants capabilities.
- **Side effects** take a stable idempotency/operation key. An ambiguous external outcome throws `ReconciliationRequired`; never blindly retry a write that timed out.
- Secrets are never logged, committed, written into journals, or sent to models. Read them from env or a credential reference.
- Backend identities (`judgement-jev/jev-1.14`, etc.) are recorded exactly as returned. Thresholds are keyed by identity. There is never a silent fallback.

## Git workflow for lanes

- You work in your own worktree branch. **Commit your work to that branch** in small logical commits. **Never push**, never add remotes, and never touch `rad` / Radicle / Railway / any deploy.
- `bun.lock` is gitignored while lanes run, so don't force-add it. Add npm deps to *your* package's `package.json` only. Root `package.json` is shared: additive edits only, and only if unavoidable.
- Commit messages end with `Co-Authored-By: <your model> <noreply@openai.com>` or the equivalent for your provider.

## Definition of done for a lane

Package typecheck passes, package tests pass, new behavior has tests (property tests for pure logic), the public surface is exported from `src/index.ts`, and there's a short `README.md` in the package covering what it does, what's verified, and what's `Unverified`.
