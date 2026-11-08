# Console interface pass

## Scope and coverage

Applied [Jakub Krehel's interface skills](https://github.com/jakubkrehel/skills) to the Overview,
its decision/activity/budget components, and the shared Shell and Meter primitives. React 19,
plain CSS, the existing Anybody/Atkinson/Martian typefaces and OKLCH tokens are retained.
No core contracts changed. No new artwork or runtime dependencies were needed.

Reviewed the repository AGENTS.md, README.md, PRODUCT.md, design/05-console.md,
design/brand/BRAND.md, existing Storybook stories, and the six owning skills loaded through
better-interface: accessibility, layout, writing, typography, colors, and UI.

This is a focused flow review, not an audit of every console screen. Account setup, trail actions,
voice, provider execution, and production behavior are outside this pass.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Shell skip link and More menu; Meter names; daily data table; keyboard fixture checks | Named meters, predictable menu focus and dismissal, keyboard access to data added |
| Layout | Overview at 320, 375, 768, 1280 and 1440px, both themes; 200% CSS zoom; long-title and RTL fixtures | Fixed summary overflow at zoom; decisions get full-width titles; budgets are bounded with an explicit onward link |
| Writing | Overview, WaitingList, ActivityFeed, SpendByDay, loading/empty/error stories | Added specific Review accessible names, visible update state, explicit daily-data disclosure and budget-limit copy |
| Typography | Rendered title, metadata, summary and engine values; long-title fixture | Body type and 1.4 line-height for decision titles; exact engine casing preserved; summary grid adapts to content width |
| Colors | Seven rendered text/background pairs in each appearance, using computed styles and sRGB canvas conversion | All sampled pairs pass 4.5:1; minimum 4.70:1 light and 5.40:1 dark. Existing palette retained |
| UI | Primary review hierarchy; loading/error/retry states; reduced-motion browser contexts; existing mobile interactions | One primary review action, existing control and artwork language retained, duplicate activity error removed |

## Findings and applied fixes

Locations refer to the resulting implementation; the Before column records what was inspected before editing.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Layout | `src/ui/ui.css:465` | Four summary columns at a wide viewport even when zoom left little content width | Auto-fit columns with a 10rem minimum and a single-column fallback | Measured overflow of spend and budget values at 200% CSS zoom; text resizing must not lose content |
| MEDIUM | Accessibility | `src/ui/primitives.tsx:431` | Rich JSX meter labels produced no accessible name | Link every meter to its visible label and explanatory note | Budget identity and incomplete-total context are exposed to assistive technology |
| MEDIUM | Accessibility | `src/ui/primitives.tsx:40` | Mobile menu opened before the trigger in DOM order without focus movement, arrow keys or Escape | Focus first/last item on open; arrows/Home/End; Escape restores trigger; Tab and outside interaction dismiss; navigation focuses main | Predictable keyboard path and focus order; skip link bypasses repeated navigation |
| MEDIUM | Layout | `src/components/WaitingList.tsx:52` | Title and Review button competed in a narrow row; metadata read as one dense string | Full-width title with separate identity, risk and action groups | Long decision titles remain legible, especially on a phone |
| MEDIUM | UI | `src/components/WaitingList.tsx:74` | Every blocking item had a primary action | Only the first, already-prioritized decision has primary emphasis | Establishes a starting point while retaining every action and blocking label |
| MEDIUM | Layout | `src/pages/OverviewPage.tsx:115` | All trail meters stretched the Overview beside a short chart | Three highest-usage budgets, explicit count and link to the complete Usage screen | Keeps the overview bounded without hiding that more data exists; totals and unknown counts are unchanged |
| LOW | Typography | `src/components/ActivityFeed.tsx:26` | Engine identities were visually uppercased; missing metadata could leave leading separators | Natural exact casing with individually wrapping metadata | Makes backend identities easier to read without changing their values |
| LOW | Writing | `src/components/SpendByDay.tsx:39`, `src/pages/OverviewPage.tsx:55` | Daily amounts table was visually hidden; Refresh showed no pending state | Native disclosure for amounts; Updating state during requests | Data has a visible, keyboard-accessible entry point; pending work is explicit |

## Verification

- App and Storybook production builds pass. Vite reports the existing large-chunk warning.
- `bun run --filter @ephyra/console typecheck` passes.
- `bun test apps/console`: 112 passing, no failures.
- The required single repository-wide run passed `bun run typecheck`; `bun test` returned 695 passing
  tests and one source-line-length failure in the new WaitingList link. The line was wrapped and
  `bun test test/style.test.ts` passed on a focused rerun. The full suite was not repeated.
- `env -u LD_LIBRARY_PATH bun apps/console/scripts/interface-polish.ts`: 26 fixture checks pass,
  including both appearances, five widths, 200% CSS zoom, long strings, an RTL stress case,
  empty/loading/error/partial-failure stories, named meters, daily amounts, skip link,
  mobile menu keys, dismissal, route focus, document titles and sampled text contrast.
- `env -u LD_LIBRARY_PATH bun apps/console/scripts/interactions.ts --only=mobile` and
  `--only=usage` both pass, including the pre-existing reduced-motion and usage-filter checks.
- Screenshots and `checks.json` are local ignored artifacts under `artifacts/interface-polish/`.
  The `before/` subdirectory preserves the original Overview at baseline `1137941` in both themes and sizes.

**Not verified:** native screen-reader announcements; Safari/iOS input behavior; OS/browser-native
zoom beyond the CSS-zoom stress check; every contrast pair or full forced-color/RTL support;
live providers, billing, accounts, forges or deployment. Fictional fixtures are not production evidence.

## Verdict

Approve for the inspected scope: the confirmed overflow is fixed and the focused checks pass.
This verdict covers the six domains listed above within the stated boundary, not general WCAG certification.
