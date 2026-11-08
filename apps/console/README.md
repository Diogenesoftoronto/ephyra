# Ephyra console

The React/Vite console is served by the Ephyra server at `/app/`. Cut E remains the public homepage.
The console uses the server API for these implemented screens:

- **Overview:** waiting decisions, recorded activity, recent spend and trail budgets.
- **Inbox:** checkpoint A/B/C and spend decisions, revision/head/proof bindings, journal evidence,
  proof results, history and trail actions. Stale approvals and read-only accounts cannot decide.
- **Usage:** 7/14-day totals, spend by day, persona/engine/trail breakdowns, budgets and a paginated,
  filterable ledger. Unknown prices stay unknown; totals are explicitly lower bounds when incomplete.
- **Team:** single-use invitations with owner-selected Viewer or Approver access, explicit joining, and revocation.
- **Runs:** an activity roster, executor/persona filters and read-only assistant-ui transcripts with tool calls, policy
  decisions and live SSE updates. Reconnection resumes by sequence without dropping received events.
- **Workspace:** the application map and autonomy, threshold and intent documents. Edit a draft
  directly or with Velum, review a proposal or json-render form, apply it, and publish a policy ref.
  Unsaved edits block switching draft views and publishing. Publishing does not change the live policy.
- **Personas:** six named roles with transparent artwork, recorded engines, activity and spend.
  Running entries use a bell pulse; directory hover/focus gives a brief greeting. Idle roles remain still.

The Overview gives decision titles a full reading column, marks one review action as primary, and shows
the three trail budgets with the highest usage ratios, with a link to all budgets in Usage. Summary totals
still cover every trail in the returned window, including the explicit unknown-cost count. Daily spend
amounts are available in an expandable table. Navigation includes a skip link and keyboard-operated
mobile More menu; budget meters use their visible labels as accessible names.

The [interface review](INTERFACE-REVIEW.md) records the scope and verification of this pass using
Jakub Krehel's skills. After building the app and Storybook, run
`env -u LD_LIBRARY_PATH bun apps/console/scripts/interface-polish.ts` from the repository root.
It uses local fictional fixtures, writes screenshots and measured checks to `artifacts/interface-polish/`,
and does not verify live providers, accounts, or deployments.

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

The connection screen offers **Sign in with Not Organic** when this server has sign-in configured.
The PKCE callback returns directly to `/app/`; the browser uses a host-only HttpOnly session cookie.
Reloading restores the session, and **Sign out** revokes it on the server. No token copying is required.
The optional **Connect with a token** section accepts an existing deployment session token (obtained through `ephyra login`).
It keeps the token in this tab's session storage and reads identity/permissions from `/v1/me`.
A service token also needs its principal; sign-in deployments restrict it to reading the console.
Demo mode uses fictional local data
and never calls a provider or a server. It is opt-in and visibly labelled.

## Onboarding, settings and controls

First sign-in opens automatic repository setup. Choose Self-driving or Supervised, connect a repository, and inspect
recorded preparation steps and blockers. **Explore first** saves setup for later; model access remains available in Settings.
Settings is available in the navigation (under **More** on phones). Hosted Not Organic access and optional personal keys
are separate choices; private Git credentials and compatible API endpoints live in expandable advanced controls.
Settings groups Repository, Model access and Account into a text tab row at every screen size.
Arrow keys and Home/End move between sections. Switching sections retains unsaved form inputs in memory;
leaving Settings, reloading, or accepting updated saved settings resets them. Setup pairs a focused form with an illustrated
explanation on wide screens. Settings keeps one reading column. Saved model connection details expand from their status row.
Keys start blank, can be replaced or removed, and are never stored in browser storage or returned by the server.
Changing provider protocol or endpoint does not silently reuse a saved key.

The model picker reads public [models.dev](https://models.dev) metadata with a bounded, credential-free request.
Search supports keyboard selection and exact custom IDs. Context limits, capabilities and published prices are metadata,
not proof of account access or actual spending. Missing metadata stays unknown; catalog failure leaves manual entry usable.

**⌘/Ctrl K** opens the command menu, **?** shows its shortcut hints, and **G** followed by O/I/R/U/W/P/T/S navigates to
Overview/Inbox/Runs/Usage/Workspace/Personas/Team/Settings. Letter shortcuts are disabled while typing or using a modal.
Menus, recessed inputs, active controls and hover/focus states share console tokens and reduced-motion behavior.
The light/dark switch sits beside Commands. It follows the system color preference until toggled;
an explicit choice is remembered in this browser. There is no separate Auto control.
New forms, pages, model picker and command menu have adjacent Storybook stories.

Welcome, invitation acceptance, and wide-screen setup include an interactive amber specimen on a textured glass surface. Hover, touch, Enter or Space triggers a 2.1-second
texture-refraction shader, then it settles. WebGL is allocated only on interaction, capped at 384px and about 30fps.
The ordinary image remains the fallback when WebGL is unavailable or lost. Reduced motion uses stills;
moving offscreen or hiding the tab stops drawing. Persona pulses use transparent stills in both themes,
without the dark rectangles of the original video exports. No animation implies that an unconfigured agent is working.

`Motion/JellySpecimen` in Storybook includes light, dark, small, keyboard, missing-art and downloadable loop examples.
The [motion asset notes](../../design/brand/CONSOLE-MOTION.md) record the image-generation prompt, source artwork,
transparent GIF/WebP exports and reproduction commands. GIFs are shareable exports; the app loads the 46KB poster
and runs its small shader only on interaction, rather than downloading a video or GIF for every visit.

The local material layers reuse the existing site artwork; two new fal Ideogram tiling candidates were rejected after
visual inspection and are not shipped. See `public/materials/manifest.json` and the motion asset notes.

Agent activity uses local Amp, Codex and Claude Code logo badges. Hover, keyboard focus or tap reveals the exact recorded
engine and execution details; Escape or an outside interaction dismisses them. The host does not determine the agent
brand. Unknown engines or unavailable artwork retain a neutral glyph and inspectable identity. Badges have separate
controls from run navigation and persona filters. Asset sources and the included license are in `public/engines/README.md`.
After building the app and Storybook, `env -u LD_LIBRARY_PATH bun apps/console/scripts/engine-badges.ts` verifies both
themes at 320/390/1440px, hoverable details, keyboard/touch access, long IDs, missing artwork and independent navigation.
These checks use fictional local runs; they do not establish live agent availability.

Account and workspace changes replace the API scope and remount cached review/voice state. The server also rejects stale
account/workspace bindings, including when another tab changes the signed-in cookie. The sign-in browser harness now
checks optional BYOK onboarding, hidden saved keys, shortcuts, real draft requests using a named offline model fixture,
and separate workspaces for two signed-in accounts.

## Team access

The owner chooses **Viewer** or **Approver** before creating a link. Viewer access reads the workspace; Approver access
also permits the existing approval, drafting, and model-assisted work allowed by the workspace policy. Repository/model
settings, setup changes, and invitations remain owner-only. Links can be used once and expire after seven days if unused.
The owner shares the link themselves; Ephyra does not send an email. Invitation labels are notes, not verified identities.
The actual signed-in DID is displayed after acceptance.

A teammate sees the exact workspace and role before choosing **Join workspace**. The invitation is retained in tab-only
session storage for at most 30 minutes to survive OAuth; accept, cancel, and sign-out clear it. Workspace selection is
remembered per account in the same tab, but every list/read/write is authorized against current server membership.
Revocation removes shared access and ends open streams. The console removes cached workspace UI when its membership
refresh confirms the removal; it refreshes every 15 seconds while visible and on focus. A removed workspace is shown explicitly rather than silently selecting another.

Interrupted invite, revoke, and accept requests retain their operation key in memory. The UI first offers a saved-state
check and then an explicit retry of that same operation. It does not blindly retry writes or claim an email was sent.
A full reload loses an in-memory write receipt; the saved membership list remains authoritative.

`team-experience.ts` tests the real local server and built UI with a fake OAuth issuer, including both roles, sign-in handoff,
explicit acceptance, reload, workspace selection, UI/server permissions, revocation, and recovery to the personal workspace.
`team-recovery.ts` tests ambiguous responses and clipboard fallback in named Storybook fixtures. `experience-layout.ts`
checks six screens at 320/390/1440 pixels in both themes. These are local checks, not live account or deployment proof.

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
bun run --filter @ephyra/console voice-interactions
bun run --filter @ephyra/console tutor-interactions
bun run --filter @ephyra/console multiplayer
env -u LD_LIBRARY_PATH bun apps/console/scripts/signin.ts
env -u LD_LIBRARY_PATH bun apps/console/scripts/account-layout.ts
env -u LD_LIBRARY_PATH bun apps/console/scripts/theme.ts
env -u LD_LIBRARY_PATH bun apps/console/scripts/motion.ts
```

The sign-in browser harness checks the public app link, PKCE redirect/callback, protected cookie, reload,
real policy-draft creation, server-side sign-out and account/workspace isolation at desktop and phone widths.
It runs the real HTTP server with a fictional Not Organic gateway; hosted account authentication is a separate live check.
Sign-in, manual connection and expired-session states are included in Storybook.
The offline account layout check covers 320–1440px, retained unsaved fields, section keyboard navigation,
optional setup, dark mode and reconciliation after an uncertain save. It captures the rendered Storybook screens.
The motion check counts real WebGL draws, verifies zero idle drawing, keyboard replay, live reduced-motion changes,
offscreen/hidden-tab suspension, lost/unavailable WebGL fallbacks, transparent persona motion and 320–1440px layouts.
Hidden-tab state is simulated. Physical mobile GPU performance and Safari are not established by this Chromium check.

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

## Voice

**Talk with Velum** is available in the work screens; onboarding and Settings keep the focus on setup.
Overview and Usage conversations use a fresh server snapshot;
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

### Automatic repository setup

Onboarding starts automatic setup after connecting a repository. Leaving the branch field blank asks the server for
its default branch. The HTTPS connector accepts clone URLs from GitHub, GitLab, Forgejo, Tangled and other Git hosts;
Radicle needs an HTTPS gateway for this connector. Native Radicle transport is not claimed by this screen.

Self-driving is the default preference; supervised checkpoints are selectable before connecting. Setup progress comes
from the authenticated workspace's `/v1/setup` record. The page shows each stage, generated documents and digests,
readiness blockers with their responsible role, and links to agent runs and requests for help. A saved repository is
never presented as proof that execution is available. Model/provider configuration remains available in the secondary
settings section, and an explicit recheck records a new setup run after a missing capability is connected.

Interrupted starts retain a credential-free operation key scoped to the account and workspace. Refreshes query that
exact key and never repeat the write automatically; a different tab's run cannot clear the uncertainty. Setup polling
pauses while the page is hidden. The workflow continues on the server after leaving the page.

Verified locally: setup HTTP contract, default/supervised startup, duplicate-mount protection, exact lost-write
reconciliation, output escaping, console tests/typecheck/build. Storybook and demo setup data are marked fictional.
Live repository authentication, provider execution, forge landing and hosted Traction remain separate integration checks.
