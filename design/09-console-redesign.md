# 09 · The console, redesigned around the loop

Status: prototype, measured, not yet in the console. Lane `ui/console-redesign`. Written 10 November 2026.

Everything this document claims is backed by a command in §9. Where something is not built or not verified, it says so.

## 1. Why the current console falls short

Ephyra's promise is that the software drives itself and people are the exception. The console in `05-console.md` is built
the other way round: it is an inbox. It opens on what needs a person, and a quest that is moving by itself has no page at
all. There is no route that lists every quest, `ConsoleClient` has no `trails()` call, and the only way to see a quest is
through an inbox item. So the screen answers "what do I have to do?" and never "what is it doing?".

That hides the four things the product is supposed to make visible:

1. **It drives itself.** Nothing shows a quest going from signal to landing with nobody touching it.
2. **It gets unstuck.** The server keeps a recovery plan for every attempt (`artefacts/recovery/…`), with the strategy it
   chose and what the previous attempt ran into. The console shows none of it.
3. **It asks the right person.** Questions are checked before they are sent and routed to a contact who covers the area.
   The console shows a question only to the person who has to answer it.
4. **It can be inspected.** Events, effects with their idempotency keys, runs and receipts all exist on the server. The
   console has no place to read them for one quest.

The redesign makes the loop the home screen and makes each of those four things something you can see and test.

## 2. What the screen has to do

One sentence states the job: **in five seconds, know what it is doing by itself and whether you are needed; in one key,
see how it knows.**

That gives three reading depths, and every layout is judged on them:

| Depth | Question | Answered by |
| --- | --- | --- |
| Glance (5 s) | Is it working? Am I needed? | The fleet sentence, and at most one loud action. |
| Read (30 s) | What is this quest doing, and why? | The quest: its stage, what it tried, who it asked, where it went backwards. |
| Inspect (any length) | How does it know? What exactly ran? | The hood: events, effects, attempts, questions, runs, receipts. |

The fleet sentence is written, not drawn: "4 quests are moving by themselves (1 recovering, 1 asking someone, 1 rolling
back). 1 needs you. 1 is stopped." A count would be faster to scan but drops the reasons, and the reasons are the product.

## 3. What was built

All of it is on the lane branch, in `apps/console`.

| Piece | Where | What it is |
| --- | --- | --- |
| View model | `src/loop/model.ts` | Pure functions from server shapes (trail, events, inbox, questions, recovery plans, runs) to what the screen says. 44 tests, property tests included. |
| Simulated hour | `src/loop/scenario.ts` | 240 ticks of seven quests, replayed through the real `lifecycle.ts` so no state is hand-written. Labelled as simulated wherever it appears. |
| Loop kit | `src/loop/parts.tsx`, `Inspector.tsx`, `loop.css` | Fleet sentence, quest row, loop meter, attempt ladder, question card, dive profile, needs-you strip, quest detail, the hood, the replay transport. |
| Design lab | `lab.html`, `src/lab/` | Seven layouts and three benches (components, alignment, motion) over the simulated hour. `bun run build:lab`. |
| Stage art | `public/loop/*.webp` | One specimen per loop stage, plus stopped and rolled back. |
| Concept images | `site/_sources/console-redesign/` | Six layout sketches generated with GPT Image, used to pick directions before any code. |

The lab is the prototype. It is not wired to a server and performs no real action.

## 4. Seven layouts, measured

`bun run lab:shots` renders every layout at 1440×900 and 390×844 in both themes and measures the first viewport.
Screenshots and `metrics.json` land in `apps/console/.screens/lab/`.

- **Glance**: of three things (the sentence, the action, the selected quest's state), how many are in the first viewport.
- **Quests**: how many quests are visible without scrolling.
- **Action y**: how far down the one primary action sits.
- **Edges**: distinct left edges of text. Fewer is calmer.
- **Screens**: page height in viewports.

| Layout | Wide: glance | quests | action y | edges | screens | Phone: glance | quests | action y | screens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A Water column | 3/3 | 7/7 | 570 | 28 | 1.0 | 2/3 | 7/7 | 603 | 1.7 |
| B Loop dial | 3/3 | 7/7 | 138 | 17 | 1.0 | 2/3 | 7/7 | 299 | 1.8 |
| C Logbook | 3/3 | 6/6 | 138 | 21 | 2.1 | 2/3 | 6/6 | 299 | 4.0 |
| D Triage bench | 3/3 | 7/7 | 138 | 25 | 1.0 | 2/3 | 5/7 | 299 | 2.1 |
| E Tide map | 3/3 | 7/7 | 138 | 30 | 1.0 | 2/3 | 2/7 | 299 | 2.7 |
| F Stage lanes | 3/3 | 7/7 | 138 | 21 | 1.0 | 2/3 | 4/7 | 299 | 2.2 |
| **H Column and bench** | 3/3 | 7/7 | 138 | 34 | 1.3 | 2/3 | 7/7 | 299 | 2.4 |

Every layout has zero nested boxes, exactly one primary action, no sideways scroll and a 36 px minimum target.

What the numbers say:

- **A** is the most alive (specimens rise and sink through a water column) but puts the action below the scene. On a
  phone the action is 603 px down.
- **B** is the calmest (17 edges) and reads the loop as a cycle. A dial has no room for a second quest at the same stage.
- **C** reads best as a story and is four screens tall on a phone.
- **D** is the fastest to act in, and is the inbox again: quests moving by themselves become a footnote.
- **E** and **F** keep position meaningful (stage is a place). They lose most quests from a phone's first screen.
- **No layout** shows the selected quest's state on a phone's first screen. That is the 2/3.

### The direction: H, with three things borrowed

**H "Column and bench"** keeps A's water column as the picture of the loop, narrow, on the left, and puts D's bench on
the right: sentence, the one action, the selected quest. It is the only layout that keeps the action high and every quest
visible at both sizes.

Its costs, to fix while building it:

- **34 left edges** at wide, the most of any layout. The column and the bench each bring their own. Target: 24 or fewer,
  by putting the bench on the alignment system in §6.
- **1.3 screens** at wide. The detail runs past the fold. Target: 1.0, with the journey list collapsed to four lines.
- **The selected quest is below the list on a phone.** Use a bottom sheet: the list stays, the quest rises over it.
- **The hood covers the bench at 1440 px.** Give it its own column above 1600 px and keep the overlay below.

Borrowed: B's dial as the loop meter inside a row; C's sentences as the journey list in the detail; F's lanes as the
phone view of the column.

## 5. Components

Each has variants in the components bench (`#/components`). The choice and the reason:

| Component | Chosen | Why |
| --- | --- | --- |
| The answer | Sentence | The tally scans faster and drops the reasons. |
| Quest row | Strip on wide, sentence under 720 px | Cards only where position already means something. |
| Loop meter | Path | The only one where going backwards looks like going backwards. Strip under 96 px. |
| Attempts | Rungs | Pills lose what each attempt ran into, which is the point. |
| Question | Letter in the detail, compact in lists | Both keep who, why them, and that it was checked. |
| Journey | Dive profile plus the last four sentences | The shape to see it, the sentences to read why. |
| Status | A glyph and a word | Colour only repeats what the glyph says. |
| Stage | One specimen per stage | Polyp to medusa as the quest matures; a cyst when stopped; a slump when rolled back. |

Rules that hold across all of them:

- **One loud surface per view.** The needs-you strip holds the only primary button on the page. Everything else is quiet.
- **Status is computed, never styled by hand.** `[data-attention]` sets one `--tone` variable; components read it.
- **No box inside a box.** Group with space and one hairline. Elevation uses shadow, and only the hood and sheet have it.
- **A quest with nothing to do shows no button.** A stopped quest whose recovery is spent needs a new lead, not "Resume".

## 6. Alignment

The alignment bench (`#/alignment`, add `?grid=1` to draw the rails) compares five systems on the same rows.

| System | Edges | Verdict |
| --- | --- | --- |
| Shared tracks | 5 | **Chosen for lists.** Rows borrow the list's columns through subgrid, so five things make five edges. |
| Hanging mark | 3 | **Chosen for the detail.** Status hangs in the margin; title and reason share one edge. |
| One edge | 1 | Calm and tall. Used on phones. |
| Ragged | many | What a flex row does by default. This is what the current console has. |
| Centred | none survive | Rejected. |

Numbers are tabular and right-aligned. Ids are monospace and never wrap. The sentence, the action and the selected
quest's title share one left edge, so the eye drops straight down the three reading depths.

## 7. Motion and interaction

Motion carries meaning here or it is not used. The motion bench (`#/motion`) plays each one with its reduced form.

| Motion | When | Spec | Reduced |
| --- | --- | --- | --- |
| Advance | A quest moves to the next stage | transform, 900 ms, ease-out; sprite swaps with a 420 ms gel pop | 150 ms fade |
| Retreat | Proof fails or production regresses | sinks back along the path, slower than it rose | 150 ms fade, the mark stays |
| Needs you | A blocking checkpoint opens | a ring leaves the button three times, then stops | none |
| New attempt | Recovery picks a different strategy | the new rung arrives, the old one dims | 150 ms fade |
| Rows arrive | A list is first shown | 12 px rise, 4 px blur, 300 ms, 60 ms apart, at most 8 | none |
| Press | Any button | scale 0.96, 150 ms | same |
| Alive | A quest is moving by itself | a 4 px bob every 4.2 s; stopped and finished quests keep still | none |
| Scrub | The replay handle is dragged | glides shorten to 120 ms | instant |

The rules, from Jakub Krehel's interface skills (`~/.codex/skills/better-*`): animate only transform, opacity and filter;
never `transition: all`; exits are faster than entrances; hover styles sit inside `@media (hover: hover)`; nothing loops
unless something is really happening; all of it is opt-in under `prefers-reduced-motion: no-preference`.

Stillness is information. Only quests that are moving by themselves move on screen, so a glance at what is bobbing is a
glance at what is working.

Keys: `j`/`k` walk the quests, `i` opens the hood, arrow keys move between its tabs, `Esc` closes it and returns focus to
where it was. **Approving takes two deliberate keys**: `a` moves focus to the primary button and shows a ring, `Enter`
presses it. A stray `Enter` approves nothing. In the lab only: `[` and `]` step the replay one tick, `{` and `}` jump
to the previous or next change, space plays, `g` draws the alignment rails, and `1` to `7` switch layouts.

## 8. End to end: what works today and what does not

`bun run loop:e2e` boots the real server in one process and drives it over HTTP, then runs the built console in a
browser. The coding agent, the decide backend and production telemetry are fixtures, named as fixtures in everything
they record (`scripted/e2e`, `fixture/e2e-decide-1`, "offline fixture"). No network is used.

Result on 10 November 2026: **7 of 23 pass, 2 fail, 14 are not reached.**

| Act | Promise | Today |
| --- | --- | --- |
| boot | A server starts from one repository link | pass |
| drives-itself | A production error reaches production with no person deciding anything | pass |
| watches-then-sets | It watches after landing and closes only when the window passes clean | pass |
| unsticks-itself | A failed first try gets a different approach; a failed proof sends it back | pass |
| stops-where-told | It stops only where policy says a person decides | pass |
| keeps-working | While one quest waits for you, another keeps working | pass |
| carries-on | Left alone, the recovering quest lands by itself | pass |
| asks-a-person | It asks the one person who would know | **fail**: this server has no `/v1/questions` |
| console-agrees | The console shows what the server holds | **fail**: the console has no `#/loop` |
| ui:* (12 checks) | The acceptance contract in §9, against the real console | not reached |
| approval-lands | One approval in the browser lands the quest | not reached |
| stays-live | The page follows the loop with no reload | not reached |

So the engine drives itself, and the console cannot show it. That is the gap in one line.

The browser checks run while one quest's agent turn is deliberately held open. A separate run
(`--server-only --hold=170`) held that turn for 177 seconds, after which the quest patched, proved and landed by itself,
so the browser half has about three minutes before the hold itself becomes the thing under test.

Not in the script yet: sign in, connecting a repository, and automatic setup. `scripts/automatic-setup.ts` and
`scripts/signin.ts` cover parts of those separately, against a fake API.

### Gaps, in the order to close them

1. **No loop view.** Add `#/loop` as the home route, built from the loop kit, in layout H.
2. **No list of quests in the client.** Add `trails()` to `ConsoleClient` (`GET /v1/trails` exists).
3. **Recovery plans are not listed.** Trail detail omits `artefacts/recovery/*`. The e2e script has to guess each file's
   name (`<step>-<rev>-<attempt>.json`) and ask for it. Return the plans with the trail detail.
4. **Effects have no per-quest route.** They are visible only in `/v1/ops`. The hood's effects tab needs them, with their
   idempotency keys, per quest.
5. **Questions exist only in `composeApplication` and only for signed-in people.** A self-hosted server started with
   `compose()` cannot ask anyone. Wire questions into `compose()` and let a reader see them.
6. **Nothing is live.** Only run events stream; quests are polled every 2 s per open quest. Add one stream for quest and
   inbox changes, and have the loop view follow it.
7. **A turn that dies without reporting usage parks the quest** with "Token usage is unknown". The scripted agent has to
   report usage before it throws. Decide whether an agent crash should cost a quest its autonomy.
8. **A probe that still fails after the patch is not a failed proof.** `buildProof` throws `Unverified("probe outcome")`
   and the quest parks, non-retryable. Only a broken test sends it back to patch. A fix that does not fix is the most
   common failure there is; it should go back to patching with that observation.
9. **Defaults stop everything.** With no decide backend every signal parks at triage; the default policy is `shadow`,
   which blocks all three checkpoints; without a watch source, landing parks. Automatic setup has to leave a new
   workspace in a state where the first low-risk signal can run by itself, and say plainly when it cannot.
10. **The console duplicates server logic.** `planRecovery` in `scenario.ts` mirrors `wiring/recovery.ts`. Once (3) lands,
    the console reads plans and stops predicting them.
11. **No way to give a stopped quest a lead.** A quest whose recovery is spent can only be resumed into the same wall.
12. **Fixtures are private to test files.** The scripted agent, decide backend and watch source live inline in
    `compose.test.ts` and now in `e2e-loop.ts`. Move one copy to a shared, labelled fixture module.

## 9. The acceptance contract

`bun run loop:accept` checks thirteen promises using only data attributes, so the same script judges the lab today and
the console when it has a loop view (`--target=console --url=…`). It passes 13 of 13 on all seven lab layouts.

| Check | Promise |
| --- | --- |
| fleet-sentence | One sentence, the only `h1`, in the first viewport, and its counts match the page |
| quest-state | Every quest shows a valid stage and status, and the status is said in words |
| one-loud-action | At most one primary action, in the first viewport, at least 36 px |
| select | Picking a quest shows that quest in the same state; `j` and `k` walk the list |
| recovery | A stuck quest shows each attempt, what it ran into, and a different strategy now |
| question | You can read the question, who it went to, and that it was checked first |
| retreat | Going backwards is drawn as going backwards, and the count matches the row |
| under-the-hood | `i` opens the hood with all six tabs; every effect has its own idempotency key |
| approve | Two deliberate keys; a stray `Enter` does nothing; the quest moves on and the sentence updates |
| calm | Under reduced motion nothing loops and nothing takes longer than 200 ms |
| phone | No sideways scroll, the action on the first screen, every target at least 24 px |
| honest-label | A simulation says it is one; the real console never wears that label |
| replay | Lab only: the hour can be stepped, and a link reopens any moment |

The attributes the console must carry:

```
[data-loop-fleet]            the sentence (an h1); spans [data-group="self"|"you"|"stopped"]
[data-quest="T-xxxxxx"]      + data-stage, data-attention, data-retreats, data-selected
[data-needs-you="T-xxxxxx"]  the strip; holds the only [data-primary]
[data-detail="T-xxxxxx"]     + data-stage, data-attention; contains [data-now]
[data-attempts] li[data-strategy]   + data-current, data-spent, data-past
[data-question][data-status] contains [data-check][data-ok]
[data-path][data-retreats]   contains [data-kind="retreat"]
[data-open-hood] [data-inspector] [data-tab] [data-panel]
[data-hood-events] [data-hood-effects] [data-idempotency-key] [data-hood-transcript] [data-hood-receipts]
[data-toast]                 role="status"
[data-sim-label]             lab only
```

Commands, all from `apps/console`:

```
bun test src/loop                 the view model and the simulated hour
bun run typecheck                 the console
bun run typecheck:scripts         the lab, acceptance and e2e scripts
bun run lab:shots                 screenshots and metrics for every layout
bun run loop:accept               the contract against the lab (add --layout=a…h)
bun run loop:e2e                  the real server and the real console (add --server-only to skip the browser)
```

## 10. Done means

- `bun run loop:e2e` exits 0: all 23 checks pass, with `asks-a-person` extended to answer the question and see the quest
  resume, and acts added for sign in, connect a repository, and automatic setup.
- `bun run loop:accept` still passes on the lab, so the prototype and the product cannot drift apart silently.
- `#/loop` is the console's home. The inbox stays as a filtered view of it.
- H's costs in §4 are paid: 24 edges or fewer at wide, one screen, a bottom sheet on phones, the hood in its own column.
- Stories exist for the loop kit; `bun run typecheck && bun test` pass across the repository.

## 11. Core changes

None so far. `@ephyra/core` is untouched. Gaps 3 to 5 need new server routes or new optional fields, not changed shapes.
