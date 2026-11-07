# Ephyra console

The React/Vite console is served by the Ephyra server at `/app/`. Cut E remains the public homepage.
The console uses the server API for these implemented screens:

- **Overview:** waiting decisions, recorded activity, recent spend and trail budgets.
- **Inbox:** checkpoint A/B/C and spend decisions, revision/head/proof bindings, journal evidence,
  proof results, history and trail actions. Stale approvals and read-only accounts cannot decide.
- **Usage:** 7/14-day totals, spend by day, persona/engine/trail breakdowns, budgets and a paginated,
  filterable ledger. Unknown prices stay unknown; totals are explicitly lower bounds when incomplete.
- **Runs:** executor/persona filters and read-only assistant-ui transcripts with tool calls, policy
  decisions and live SSE updates. Reconnection resumes by sequence without dropping received events.
- **Workspace:** the application map and autonomy, threshold and intent documents. Edit a draft
  directly or with Velum, review a proposal or json-render form, apply it, and publish a policy ref.
  Unsaved edits block switching draft views and publishing. Publishing does not change the live policy.
- **Personas:** six named roles with existing still/motion assets, recorded engines, activity and spend.
  Motion is restricted to the selected active persona and respects reduced-motion preferences.

## Run

From the repository root:

```sh
bun run --filter @ephyra/console build
bun run --filter @ephyra/server start
```

The server's [configuration](../server/README.md) determines its port, backing store, authentication,
model and repository. `EPHYRA_CONSOLE_DIR` can override the default built console directory.
For UI development use `bun run --filter @ephyra/console dev`. Point a reverse proxy at that dev
server and the Ephyra API on the same origin, or use the isolated demo at `/app/?demo=1`.

The connection screen accepts an existing deployment session token (obtained through `ephyra login`).
It keeps the token in this tab's session storage and reads identity/permissions from `/v1/me`.
A service token also needs its principal; sign-in deployments restrict it to reading the console.
The console does not yet complete browser SSO automatically. Demo mode uses fictional local data
and never calls a provider or a server. It is opt-in and visibly labelled.

## Shared reviews

The real Inbox shows authenticated authors, comments and review handoffs from the git journal.
Selected trails refresh every two seconds, with bounded retries and a connection indicator. Incoming
changes and transient read failures preserve the comment input, selection and draft. Drafts and
unconfirmed operations stay in memory per API connection, principal and trail across navigation.
They are not a durable offline outbox and are lost on a full page reload.

Approvers can claim a review at checkpoints A, B and C. The claim records the owner and blocks
workflow decisions until that owner releases it; other approvers can still comment. Claims do not
stop or start agent processes. Active-agent takeover, online presence and collaborative editing are
not implemented. A failed proof ends a held review before ordinary repair work resumes.

Comments, claims and releases carry durable operation keys. If a reply is lost, **Check delivery**
reads the journal receipt. A recorded change is confirmed without another write. If no receipt is
found, **Retry saved change** explicitly resends the same saved intent and key. The console never
automatically retries an ambiguous write. Changed checkpoint bindings require an explicit review
reload before deciding.

## Storybook and checks

Every component and screen has a story, including assistant-ui parts, the validated json-render
catalog and the server-rendered sign-in views. Loading, empty, unavailable, stale, read-only,
publish-conflict, dark and mobile states are included. `src/storybook/coverage.test.ts` keeps new
components and screens from losing story coverage.

```sh
bun run --filter @ephyra/console storybook
bun run --filter @ephyra/console build-storybook
bun run --filter @ephyra/console typecheck
bun test apps/console
bun test test/console-contract.test.ts
bun run --filter @ephyra/console smoke --no-build
bun run --filter @ephyra/console interactions
bun run --filter @ephyra/console multiplayer
```

Build both the app and Storybook before `interactions`. The browser scripts start temporary loopback
static servers, close them on completion, and use the installed Playwright Chromium headless shell.
They run with `LD_LIBRARY_PATH` unset to avoid the local Nix/Chromium library mismatch. `smoke`
renders every story at desktop and phone widths; `interactions` exercises draft edits, forms,
proposals, publishing, usage filters/pagination, mobile navigation, live events and refusal states.
Screenshots go to the ignored `artifacts/interactions` directory.

`multiplayer` starts an isolated loopback server with production HTTP handlers, trail engine and git
journal, then uses independent Chromium profiles. Identity resolution and review snapshots are fixtures;
shared comments, claims, releases and receipt checks use real requests and durable journal writes.
It checks authorization, competing claims, draft/caret preservation, reconnect catch-up, ambiguous
delivery, explicit same-key retry with a newer draft, changed review bindings, and mobile layouts.
Its screenshots go to `artifacts/multiplayer`. Hosted Not Organic
sign-in and multiple server processes remain unverified by this harness.

Verified locally: schema-validated client/server contracts, draft publication to a temporary git
repository with a fake model, unit/property tests, app/Storybook builds, and the local browser checks.
Unverified: live provider replies, hosted sign-in with a real account, live agent/orb streams,
production deployment and cloud/forge writes. Storybook/demo fixtures are not evidence for those.
