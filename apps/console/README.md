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
bun run --filter @ephyra/console voice-interactions
bun run --filter @ephyra/console tutor-interactions
```

Build both the app and Storybook before `interactions`. The browser scripts start temporary loopback
static servers, close them on completion, and use the installed Playwright Chromium headless shell.
They run with `LD_LIBRARY_PATH` unset to avoid the local Nix/Chromium library mismatch. `smoke`
renders every story at desktop and phone widths; `interactions` exercises draft edits, forms,
proposals, publishing, usage filters/pagination, mobile navigation, live events and refusal states.
Screenshots go to the ignored `artifacts/interactions` directory.

Verified locally: schema-validated client/server contracts, draft publication to a temporary git
repository with a fake model, unit/property tests, app/Storybook builds, and the local browser checks.
Unverified: live provider replies, hosted sign-in with a real account, live agent/orb streams,
production deployment and cloud/forge writes. Storybook/demo fixtures are not evidence for those.

## Voice

**Talk with Velum** is available throughout the console. Overview and Usage conversations use a fresh server snapshot;
opening a trail or run supplies that resource's recorded context. These conversations explain the evidence and have
no mutation tools. In an open document, spoken and typed turns use the same saved Velum thread, generated forms and
reviewable proposals. Dirty, closed and read-only drafts retain their existing guards.

**Dictate** records up to one minute, transcribes it and presents editable text. **Insert text** appends to the
existing composer without sending. **Read aloud** narrates journal documents, recorded proof summaries and Velum
replies. Long text is split into bounded requests without dropping content. Velum is the narrator; reading another
agent's evidence does not impersonate that agent.

The interaction is turn-based: Start recording → Send turn → captioned reply → spoken playback. Interrupt and speak
stops playback before opening the microphone. Replay uses the already-generated audio. It does not regenerate or
charge for the same clip. This is not a full-duplex realtime session, and there is no automatic provider fallback.

Capture starts only from a user gesture. Actual input/output levels drive the meter. Escape, closing the panel,
disconnecting, changing views and hiding the tab stop capture/playback. Late microphone permissions and responses
cannot attach themselves to a later document or session. A request already dispatched can still finish or be billed;
uncertain outcomes are surfaced with a link to Usage. Microphone capture needs HTTPS or localhost in supported
browsers ([MediaDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)).

Speech uses the [server's voice configuration](../server/README.md#voice). No provider credentials enter the browser.
Session usage shows returned receipts, including unknown costs and unreported backend identities. The ledger uses
Velum's existing `draft` category with `voice.transcribe`, `voice.reply` and `voice.speak` steps. Draft replies keep their
existing `draft` step. Audio is transient; generated audio has a bounded two-minute server replay cache. Idempotency
records retain completed text results and receipts, not audio. Draft messages persist with the draft; the general
conversation display clears when closed.

`Voice/Conversation` contains 19 stories, including interactive drafting/dictation, loading, recording, permission
denial, unavailable speech, uncertain charge, blocked playback, read-only controls and dark mode. The browser-audio
story uses real capture with a fixed transcript and silent WAV, clearly labelled as a fixture. The automated voice
browser check covers desktop/mobile flows and real MediaRecorder/Web Audio with Chromium's synthetic microphone.

Verified locally: provider HTTP contracts with fakes, principal-scoped durable operation replay, unknown-charge
handling, cancellation, late-result isolation, text preservation, actual browser capture/decoding and both viewport
layouts. Unverified: real microphone hardware/permission UX, intelligibility, provider latency/availability, actual
wallet settlement, mobile Safari and production delivery. No paid provider calls were made for these checks.

## Ampersand and Tutor

Velum can use Ampersand to work through ambiguous intent and propose document changes. This is an optional server
configuration; the console keeps the same saved thread, reviewable proposals and explicit apply/publish controls.

Every trail has **Understand this trail**. **Explain this trail** asks &Tutor to walk through recorded evidence and the
current checkpoint. Follow-up questions, editable dictation and **Talk with &Tutor** use the same explanation endpoint.
Velum narrates Tutor's text through the configured speech provider, with captions and separate receipts. Tutor is not
presented as a native audio model. Answers also remain visible in the trail panel while the view stays open.

**Records Tutor received** shows the exact bounded excerpts, alongside the revision, model identity and recorded cost.
Missing proof stays missing. A changed trail refuses a new question or labels an in-flight answer stale. Uncertain
requests stop further submission until the operator reconciles them. The panel has no approval controls; existing
checkpoint controls remain the decision surface. Read-only accounts can inspect availability but cannot spend.

`Components/TutorPanel` contains nine stories covering availability, loading, thinking, explanations, stale evidence,
unknown outcomes, read-only access and dark mode. They use labelled fixtures. The browser check exercises explanations,
sources, follow-ups and the voice handoff at desktop and phone widths. [Server configuration](../server/README.md#humans-collaboration-and-tutoring)
documents Not Organic account routing, direct Humans& keys, limits and what remains unverified.
