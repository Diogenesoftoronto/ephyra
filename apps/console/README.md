# Ephyra console

The React/Vite console is served at `https://console.ephyra.quest/app/`. The public homepage at
`https://ephyra.quest` embeds the same components with explicitly fictional walkthrough data.
The console uses the server API for these implemented screens:

- **Overview:** waiting decisions, recorded activity, recent spend and quest budgets.
- **Inbox:** checkpoint A/B/C and spend decisions, revision/head/proof bindings, journal evidence,
  proof results, history and quest actions. Stale approvals and read-only accounts cannot decide.
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
the three quest budgets with the highest usage ratios, with a link to all budgets in Usage. Summary totals
still cover every quest in the returned window, including the explicit unknown-cost count. Daily spend
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
Settings groups Repository, Model access, Connections and Account into a text tab row at every screen size.
Arrow keys and Home/End move between sections. Switching sections retains unsaved form inputs in memory;
leaving Settings, reloading, or accepting updated saved settings resets them. Setup uses one open reading column over a
full-page material, with three compact steps and optional connections collapsed. Saved model connection details expand from their status row.
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

Welcome and invitation acceptance use an amber specimen; each persona has its own short generated greeting.
Hover or keyboard/touch activation starts one finite gesture. Clips are silent, load only on interaction, stop offscreen
or in a hidden tab, and support explicit pause/replay. Reduced motion retains the still without requesting video.
Data-saving and touch devices wait for explicit play. Decoders without VP9 transparency fall back to the approved still.
Custom specimen artwork retains the earlier WebGL shader. Decorative greetings never represent agent activity.

**Sound** is off by default. Opting in enables quiet touch, copy, connected and invitation cues, with a shared throttle,
no preloading and immediate cross-tab mute. Success cues follow confirmed results. The study gallery also includes
message and attention cues, which are not wired to application events. The [motion and sound notes](public/juice/README.md)
list exact models, requests, selected derivatives and the experiment limits. All playback uses local assets; the app
never generates media or sends credentials to fal.

The shell uses pale and slate glass tiles, and each of the six personas has a distinct generated material. Decorative
layers sit behind readable surfaces. The [material notes](public/materials/README.md) retain the fifteen selected Ideogram
tile studies, illustration sources and older motion comparisons. Current entrance motion uses the reviewed H3 Max,
FLUX 3 Max and Seedance 2.5 character clips; the earlier Kling/Wan background study is no longer played there.

The repository picker includes GitHub, GitLab, Tangled, Forgejo and generic Git logos and links. Public GitHub discovery
fills the repository address and default branch without submitting settings. It uses no credentials, cancels stale
lookups, and retains manual entry on rate limits or errors. Private repositories still use the existing credential flow.

### Public app walkthrough

`bun run --filter @ephyra/console build:walkthrough` builds the same App and TrailPanel components for `site/e/app/`.
The web Docker build performs this automatically. Six feature views show Overview, setup, Runs, Workspace, Personas
and Team. The nine-stage bug tour renders the real quest panel from the checked-in CLI walkthrough recording.
Sample accounts and teams are fictional; the tour creates no repository, invitation or provider job. Its separate
entry uses fake adapters, a network-blocking CSP and an allowlisted same-origin parent-message protocol.

Inline previews leave scrolling to the landing page. The reader opens interactive screens in a native dialog.
Scene changes scroll only their own document; route focus uses `preventScroll` so it cannot move the host page.
The shared-browser probes `scripts/landing-scroll.probe.js` and `scripts/landing-workspace.probe.js` check story
alignment in both directions, workspace switching, narrow frames, dialog focus/position restoration and the origin boundary.
The visible term is **quest**; existing `Trail` types, routes, event names and saved IDs remain compatible.

`env -u LD_LIBRARY_PATH bun apps/console/scripts/product-walkthrough.ts` checks all six views and nine stages at
390/1440px, recorded proof, foreign-origin message refusal, errors and layout. `juice-interactions.ts` checks repository
selection, finite gestures, all seven alpha clips, opaque-decoder fallback and reduced motion. `feedback.ts` checks
opt-in, throttling, cross-tab mute and actual browser decoding of all six cues. These are offline Chromium checks;
physical mobile devices, Safari transparency, live forge authentication and human audio evaluation remain unverified.

Agent activity uses local Amp, Codex and Claude Code logo badges. Hover, keyboard focus or tap reveals the exact recorded
engine and execution details; Escape or an outside interaction dismisses them. The host does not determine the agent
brand. Unknown engines or unavailable artwork retain a neutral glyph and inspectable identity. Badges have separate
controls from run navigation and persona filters. Asset sources and the included license are in `public/engines/README.md`.
After building the app and Storybook, `env -u LD_LIBRARY_PATH bun apps/console/scripts/engine-badges.ts` verifies both
themes at 320/390/1440px, hoverable details, keyboard/touch access, long IDs, missing artwork and independent navigation.
These checks use fictional local runs; they do not establish live agent availability.

Runs and the agent roster offer **Open Amp orb** (or the recorded agent session) and **Open app preview** when those links
exist. A live `run_state` frame updates them during execution. Amp's thread supplies its conversation, terminal, files and
portal; Ephyra membership does not grant access to an Amp account. No orb URL or ID is guessed from the launcher's sandbox.

The **From the agent** panel displays saved interactive HTML alongside the transcript. Agents publish through the
[stream envelope](../../packages/agent/README.md#sharing-a-visual-during-a-run), using ordinary shell tools or an explicit
assistant block. Pages resize, adopt the current theme and expand without resetting their controls. A later revision waits
behind **Load update**; saved visuals replay after the run finishes and the page reloads. Portal links remain external and
are not presented as proof of health. The HTML frame has an opaque origin, no access to Ephyra's DOM/storage, and a CSP
blocking external requests and form submissions. Inline scripts, styles and data-URI media remain available.

The design follows T3 Code's [saved visual reference](https://github.com/pingdotgg/t3code/blob/dff0b1159bf7aa3ad5e5598d6e1bb7d6243f51a2/packages/shared/src/htmlRender.ts)
and [isolated document frame](https://github.com/pingdotgg/t3code/blob/dff0b1159bf7aa3ad5e5598d6e1bb7d6243f51a2/apps/web/src/components/files/BrowserDocumentFrame.tsx).
Ephyra does not claim T3's headless preview measurement or MCP publication tools: publication here is captured from its
existing run stream. `run-handoff.ts` exercises that stream through a real local server, recorder and browser at 320/390/1440px
in both themes. Agent output is a named fixture. Live Amp access, provider behavior, deployed storage and Safari remain unverified.

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
Selected quests refresh every two seconds, with bounded retries and a connection indicator. Incoming
changes and transient read failures preserve the comment input, selection and draft. Drafts and
unconfirmed operations stay in memory per API connection, principal and quest across navigation.
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
The motion check covers the custom-art shader: real WebGL draws, zero idle drawing, keyboard replay, live reduced-motion changes,
offscreen/hidden-tab suspension, lost/unavailable WebGL fallbacks, transparent persona motion and 320–1440px layouts.
Hidden-tab state is simulated. Physical mobile GPU performance and Safari are not established by this Chromium check.

Build both the app and Storybook before `interactions`. The browser scripts start temporary loopback
static servers, close them on completion, and use the installed Playwright Chromium headless shell.
They run with `LD_LIBRARY_PATH` unset to avoid the local Nix/Chromium library mismatch. `smoke`
renders every story at desktop and phone widths; `interactions` exercises draft edits, forms,
proposals, publishing, usage filters/pagination, mobile navigation, live events and refusal states.
Screenshots go to the ignored `artifacts/interactions` directory.

`multiplayer` starts an isolated loopback server with production HTTP handlers, quest engine and git
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
opening a quest or run supplies that resource's recorded context. These conversations explain the evidence and have
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

Every quest has **Understand this quest**. **Explain this quest** asks &Tutor to walk through recorded evidence and the
current checkpoint. Follow-up questions, editable dictation and **Talk with &Tutor** use the same explanation endpoint.
Velum narrates Tutor's text through the configured speech provider, with captions and separate receipts. Tutor is not
presented as a native audio model. Answers also remain visible in the quest panel while the view stays open.

**Records Tutor received** shows the exact bounded excerpts, alongside the revision, model identity and recorded cost.
Missing proof stays missing. A changed quest refuses a new question or labels an in-flight answer stale. Uncertain
requests stop further submission until the operator reconciles them. The panel has no approval controls; existing
checkpoint controls remain the decision surface. Read-only accounts can inspect availability but cannot spend.

`Components/TutorPanel` contains nine stories covering availability, loading, thinking, explanations, stale evidence,
unknown outcomes, read-only access and dark mode. They use labelled fixtures. The browser check exercises explanations,
sources, follow-ups and the voice handoff at desktop and phone widths. [Server configuration](../server/README.md#humans-collaboration-and-tutoring)
documents Not Organic account routing, direct Humans& keys, limits and what remains unverified.

### Automatic repository setup

Onboarding starts automatic setup after connecting a repository. Leaving the branch field blank asks the server for
its default branch. The address field accepts HTTPS clone/browser URLs from GitHub, GitLab, Forgejo and other Git hosts,
native Radicle IDs/app links, and Tangled browser links or exact AT URIs. The server resolves and verifies the identity;
native transport availability is reported by that server. Private access can bind a credential to the resolved HTTPS
host; private Radicle uses a server-managed account identity. Saved source identity and clone metadata are inspectable.

Self-driving is the default preference; supervised checkpoints are selectable before connecting. Setup progress comes
from the authenticated workspace's `/v1/setup` record. The page shows each stage, generated documents and digests,
readiness blockers with their responsible role, and links to agent runs and requests for help. Active investigations
are distinguished from remaining landing/watch blockers. Actual hosted execution configuration appears separately; a saved repository is
never presented as proof that execution is available. Model/provider configuration remains available in the secondary
settings section, and an explicit recheck records a new setup run after a missing capability is connected.

Interrupted starts retain a credential-free operation key scoped to the account and workspace. Refreshes query that
exact key and never repeat the write automatically; a different tab's run cannot clear the uncertainty. Setup polling
pauses while the page is hidden. The workflow continues on the server after leaving the page.

Verified locally: setup HTTP contract, default/supervised startup, duplicate-mount protection, exact lost-write
reconciliation, output escaping, console tests/typecheck/build. Storybook and demo setup data are marked fictional.
Live repository authentication, provider execution, forge landing and hosted Traction remain separate integration checks.
### QR invitations

The freshly created Viewer or Approver invitation includes an SVG QR and a downloadable PNG. Both encode the
exact single-use link locally with `qrcode.react`; no QR service receives the redeemable token. The normal
sign-in, role preview and deliberate acceptance flow applies. The QR disappears on expiry, or when refreshed
team state reports acceptance or revocation. The ordinary link remains available for clipboard/manual use.

`scripts/team-experience.ts` decodes actual rendered pixels at 320/390/1440px in both themes, decodes both PNG
downloads, and uses the decoded URLs through real local authority with a fake OAuth issuer. The recovery script
checks revoked and time-expired QR removal. Camera hardware, public-host reachability and Safari/iOS are unverified.

### Knowledge and MCP connections

The optional knowledge panel appears during onboarding and in **Settings → Connections**. **Connect knowledge** saves
the workspace's opt-in with no selected sources. When needed, the server-provided Not Organic sign-in link requests
access; **Manage connections in Not Organic** opens that application's connection grant and return location. Credentials
remain in Not Organic. **Explore first** still works without enabling knowledge.

Users choose shared resources and an eligible search tool once for autonomous research. The selection saves the exact
source ID, tool definition hash and query field; nothing is preselected. Changed tools and revoked sources remain visible
until explicitly replaced or removed. Unsupported tools can be inspected but cannot be selected. **Disconnect knowledge**
clears Ephyra's workspace opt-in and selections; Not Organic's portal manages its application grant separately.

Catalogs refresh on an explicit refresh or return to the page. Account/workspace changes discard loaded and pending form
state, and late reads/saves cannot update another scope. Interrupted saves lock further changes until a read-only refresh
of saved settings; revision conflicts similarly require review. Source names and descriptions render as text, and links
allow HTTPS, same-app paths, or credential-free HTTP loopback addresses for local development.

Verified locally: account API binding and response validation, exact tool selection, source revocation, escaping,
unknown-save recovery, keyboard tab focus, desktop/390px layouts, optional onboarding skip, and account/workspace
isolation. Run `bun run --filter @ephyra/console build`, then
`env -u LD_LIBRARY_PATH bun apps/console/scripts/knowledge.ts` for four browser scenarios using offline HTTP fixtures.
`Account/Knowledge connections` and `Screens/SettingsPage` provide fictional state and phone stories. Hosted Not Organic
authorization, upstream MCP connectors and live autonomous research remain separate integration checks.

### Production signals and routed questions

Onboarding and **Settings → Connections** include collapsed, optional PostHog and contact-routing controls. PostHog
uses an HTTPS instance origin, numeric project ID and write-only personal API key. Including recording context is an
explicit choice. The console shows the server's actual access-check status and timestamp; saved settings are not proof
that a project was contacted. Disabling PostHog removes its saved key. Endpoint/project changes do not reuse a prior key.

The workspace owner receives factual questions in Inbox without additional configuration. Additional contacts have a
stable delivery ID, alias, roles and relevant areas; an authenticated webhook delivers their question and private answer
link. The delivery token is write-only. These choices permit autonomous investigation; answers supply evidence and do
not approve code or grant capabilities. Contact routing can be disabled without introducing an approval checkpoint.

Inbox shows question/answer checks with exact model identities and request/response evidence, delivery state and the
bound quest revision. Only the addressed account gets an answer form. Historical `questions/latest.json` records also
render in quest evidence. An interrupted answer stores only a credential-free question/operation reference in session
storage, scoped to the account and workspace. Reload reads the exact saved record even if the resumed quest disappeared
from the active question list; it never repeats the POST. Missing records remain explicitly unconfirmed.

Connection saves use account/version/workspace bindings and operation keys. Conflicts and uncertain saves require a
read-only refresh before another change. Account/workspace switches discard draft keys and ignore late saved results.
Aliases and sign-out remain in Account settings. New connection/question stories use visibly fictional data.

After building, run `env -u LD_LIBRARY_PATH bun apps/console/scripts/connections.ts` for offline browser checks at
1440px and 390px: optional setup, native address submission, automatic start, PostHog/contact choices, keyboard tabs,
escaped question evidence, addressed replies, lost-answer reload recovery, settings conflict/reconciliation and account
isolation. Screenshots and a verification manifest are written under ignored `artifacts/connections`. These checks do
not establish live forge access, PostHog credentials, webhook delivery or model checking.
