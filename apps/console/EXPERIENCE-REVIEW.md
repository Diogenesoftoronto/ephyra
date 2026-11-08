# Entrance, setup, and shared work — November 8

This extends the earlier Overview pass using Jakub Krehel’s interface, accessibility, writing, layout, typography,
color and UI skills. It keeps the established honey-jelly identity and the automatic setup behavior merged from
`3733c46`, then carries that direction through sign-in, setup, invitations and agent activity.

## What changed

- A textured glass entrance with the existing amber specimen, a focused account action, clear first-visit copy,
  a compact phone composition, and a separate optional token connection.
- Automatic setup pairs real repository preparation progress with a clear explanation. Automation choices use
  explicit selected states. Saved blockers and artifacts remain visible; decoration never claims readiness.
- Local light/dark glass materials add depth to the shell and team explanation; reading surfaces remain opaque.
  Existing bounded specimen refraction provides interaction. There is no autoplay video or runtime media request.
- Runs show six recognizable roles, their actual recorded activity and exact engine identities. The latest 100
  runs refresh every five seconds while visible; missing activity and engines remain explicitly absent.
- Owners choose Viewer or Approver when creating an invitation. The recipient sees the workspace, owner and role
  before joining. Shared selection survives reload, stays account-bound, and remounts the workspace API scope.
- Invitations can be revoked before or after acceptance. Server authorization checks current grants, and active
  shared streams stop after revocation. The guest UI removes cached workspace data on refresh/focus.

The two fal `ideogram/v4/tiling` attempts returned unusable gray images containing text artifacts. Neither is shipped.
The existing site materials were reused after visual inspection. Generation receipts and the rejected status are
recorded without credentials; actual billing is unknown. No additional paid retries were made.

## Findings resolved during integration

1. The invitation client initially omitted the workspace header required by the authority. The real browser flow
   caught the 409 response. Invite/revoke now bind the same workspace in header and payload, with regression assertions.
2. OAuth initially had no invitation handoff. A tab-only, thirty-minute receipt now preserves the exact token and
   clears on acceptance/cancellation/sign-out. Malformed new links clear an older pending receipt.
3. Shared workspace selection initially reset on reload. The per-account preference now persists in the tab, while
   the server still reauthorizes it. Removed access produces an explicit unavailable screen rather than a silent switch.
4. The phone illustration initially clipped its touch target. The compact stage now contains the complete control.
5. Existing command-menu ranking expectations were extended for Team. All new source lines meet the repository limit.

## Verified

- Repository-wide typecheck passed; the single full test run returned **788 passing, zero failing**.
- After the final selection/refresh adjustments, console typecheck and **132 scoped tests** passed.
  The subsequent invitation-expiry/property-test pass returned **12 passing tests** across four targeted files.
- Production app and Storybook builds pass. The existing large-entry-chunk warning remains.
- `signin.ts`: real loopback HTTP, fake OAuth issuer, account cookies, automatic setup, saved configuration, reload,
  draft creation and sign-out at 1440/390px; separate-account isolation.
- `automatic-setup.ts`: autonomous desktop, supervised phone, interrupted start and reload reconciliation.
- `team-experience.ts`: owner-created Viewer and Approver invitations, OAuth handoff, no implicit acceptance,
  role preview, deliberate joining, shared selection after reload, UI/server authority, keyboard revocation dialog,
  revoked workspace removal, and return to the personal workspace.
- `team-recovery.ts`: explicit saved-state reconciliation, same-operation retry, no duplicate invitation,
  manual clipboard fallback, expired-link protection, and revocation after opening the invitation in named fixtures.
- `experience-layout.ts`: 36 light/dark renders across 320/390/1440px; six screens, control bounds, loaded artwork,
  and no runtime errors. Team and acceptance screens were rechecked after final control and copy changes.
- `interface-polish.ts`: all 26 earlier overview/navigation/contrast/zoom fixture checks still pass.
- `motion.ts`: actual bounded WebGL draws, keyboard activation, reduced motion, idle/offscreen/hidden-tab termination,
  missing/lost WebGL fallback, and responsive integration pass.

Screenshots and JSON records are ignored local artifacts under `apps/console/artifacts/experience/`, `signin/`,
`automatic-setup/`, `interface-polish/` and `motion/`. The self-contained `artifacts/experience/review.html` collects
six screens in both themes and sizes. These are rendered UI evidence, not live production activity.

## Boundaries and core changes

New additive core exports live in `packages/core/src/team.ts`: role, invitation, team state, workspace access,
preview and mutation schemas. No existing exported core shape changed. Server account storage has an optional
private team record; credentials and redeemable invitation secrets never enter public account settings.

Hosted sign-in, deployed Convex behavior, real provider work, actual billing, distributed load, email delivery,
Safari/iOS and native screen readers remain unverified. Workspace discovery currently scans account records.
No push or deployment was performed. The work is committed on `ui/jakub-console-polish`.

## Live runner access and agent presentations — November 8

Agent rows now use local Amp, Codex and Claude marks, with exact engine and runner details available on hover,
keyboard focus and touch. Real recorded Amp thread and portal links appear while a run is still active.
Remote executor identity is retained instead of being overwritten by the local launcher process.

Following T3 Code's persisted HTML presentation and isolated-frame pattern, agents can publish a self-contained
HTML visual through a successful tool result or an explicit assistant envelope. It arrives over the existing run
stream, is saved with the run and survives reload. The viewer supports theme changes, expansion without resetting
interaction, and deliberate loading of a newer revision. External app previews remain separate links. These are
presentations, not proof items. This does not add T3's headless preview or MCP tools.

### Verification

- All package typechecks pass after correcting two test-only callback signatures in agent and server tests.
- The single repository run returned 803 passing and two failing tests out of 805. Both failures were caused by
  this change: a core test was in the source-only directory, and the idle-stream test had not consumed the new
  initial state frame. Both were corrected; all 60 focused regression checks across nine files then passed.
- Six real local HTTP/normalizer/store/SSE/browser flows cover both themes at 320/390/1440px: live metadata,
  visual interaction, isolated storage/DOM/network, theme propagation, modal shortcuts, Escape, update selection,
  persistence after completion and reload, and bounds. Provider stream contents are explicit test fixtures.
- Eight badge interaction/fallback groups, six Runs layouts, the Runs interaction flow, and all 26 earlier
  interface checks pass. Production app and Storybook builds pass with the existing chunk-size warning.

### Core changes

New additive `RunVisual` schema export and optional `AgentRunEvent.visual` field. Existing required contracts,
event kinds and proof authority are unchanged. Live Amp/provider execution, deployed Convex persistence,
cross-device access, Safari/iOS and production deployment remain unverified.

## Scan-to-join invitations — November 8

Fresh invitations now show a locally encoded QR beside the copyable link, with a downloadable 960px PNG.
The selected Viewer or Approver role remains part of the server-owned invitation; scanning does not bypass
sign-in, preview or deliberate acceptance. The app removes the displayed QR when its link expires or when
refreshed state reports acceptance/revocation. The original manual-copy recovery remains available.

The real local account/browser check passed all twelve displayed-QR decodes across roles, themes and
320/390/1440px widths, plus both PNG decodes. Both decoded URLs completed the sign-in and joining flow.
Revocation and clock-driven expiry removal passed in the recovery fixture. Public phone reachability,
camera hardware and Safari/iOS remain unverified. No core changes were needed for QR invitations.
