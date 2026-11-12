---
title: The terminal inbox
summary: Decide checkpoints from the keyboard. The list of what is waiting on the left; what each item asks you to judge on the right.
---

If your day is spent in a terminal, the inbox should be there too. `ephyra inbox` is a full-screen view of everything waiting on a person, with enough of each quest on screen to decide without opening anything else.

```sh
ephyra inbox
```

## What you are looking at

The left pane lists what is waiting. The right pane shows the selected item:

- **Checkpoint A** shows the agent's `hypothesis.md`, with the triage behind it: the route, how actionable the signal was, duplicates, and the exact identity of the model that decided.
- **Checkpoint B** shows the failing reproduction and `plan.md`.
- **Checkpoint C** shows the proof bundle for the current revision: the reproduction before and after, tests, regression and intent probes, traffic replay, story checks, the scope of the diff, the review agent's findings, and anything missing.
- **Spend, parked and notice items** show what is being asked and the budget.

Above the item, a rail shows how far the quest has got (signal → evidence → hypothesis → repro → plan → patch → proof → land → watch) and where A, B and C sit. Below it is the quest's recent activity.

The bottom line lists only the keys that do something for the selected item. The line above it carries a short tip about what you are looking at.

## Keys

| Key | Does |
|---|---|
| `j` `k` | Move between items |
| `g` `G` | Jump to the first or the last item |
| `a` | Approve the checkpoint or the spend. At C, this lands the quest |
| `r` | Send it back with a note |
| `x` | Kill the quest, with a reason |
| `c` | Comment; everyone on the quest sees it |
| `t` | Claim a checkpoint review, so nobody decides it under you |
| `u` | Release a review you claimed. Do this before deciding |
| `p` | Park it, or resume it |
| `l` | Land a ready quest whose proof is already approved |
| `o` | Open the landing or the agent's thread in your browser |
| `e` | Explain: the evidence behind the item. Press again to go back |
| `J` `K` | Scroll the right pane |
| `R` | Refresh from the server now |
| `d` | Show the address of the documentation page for what is selected |
| `?` | List the keys, with tips |
| `esc` | Back to the quest |
| `q` | Quit |

While you write a note, only `enter` (send) and `esc` (cancel) apply.

> [!TIP]
> Press `e` before `a`. The evidence pane lists the sources a checkpoint rests on. A source marked unavailable is a gap in the evidence, not a pass.

## Things worth knowing

**A decision is bound to what was on screen.** When you press `a`, the inbox sends the revision, commit and proof it was showing. If the quest changed underneath you, the server refuses it, the item returns to the list, and you get `Stale decision; refresh before retrying`.

**Approving C lands the quest.** The hint reads `a approve and land` at checkpoint C for that reason. `l` is for the other case: a quest that is ready and whose proof was approved earlier.

**Read-only is a clear refusal.** If your account cannot approve here, the key tells you so (`Read-only here…`) instead of reporting an unknown outcome.

**An unknown outcome is reported as unknown.** If a write gets no answer, the inbox says `Action failed or outcome unknown; refresh before retrying`, puts the item back, and does not retry. Press `R` and look before trying again.

**Colour means state and nothing else.** Mint is waiting on you. Amber is work that holds: a stage done, proof passed, a landing. Cherry is a failure or an undo. Keys, labels and the selection are neutral.

**It refreshes.** After any change the list reloads straight away, and otherwise every 30 seconds. Each quest's details are fetched once per thing to judge, and again when it reaches its next checkpoint.

## Narrow terminals

| Width | Layout |
|---|---|
| 80 columns or more | List and detail side by side |
| 60 to 79 | The list stacked above the detail |
| Under 60 | The selected item gets the whole screen; its title says where it sits (`1 of 4`), and `j` `k` still move |

The inbox needs at least 40 columns and 10 rows.

## Settings

| Variable | Effect |
|---|---|
| `EPHYRA_TIPS=0` | Hide the tip line |
| `EPHYRA_ANSI=1` | Use the plain ANSI renderer instead of OpenTUI, for terminals where the default misbehaves |

## Without the full screen

The same views print as ordinary output, for a pipe or a quick look:

```sh
ephyra show T-1a2b          # the quest view, full width, with the hypothesis and plan
ephyra quests               # a table of every quest
ephyra inbox --json         # the waiting items as JSON
```

## When nothing is listed

An empty inbox means no checkpoint is waiting on a person. It does not mean nothing is happening. `ephyra quests` lists every quest, `ephyra activity` shows the agents at work, and `ephyra setup` shows whether something is blocking the loop from starting. If you expected an item, see [troubleshooting](./troubleshooting#the-inbox-is-empty-but-i-expected-something).

## Limits

The inbox has been driven end to end in tmux against the server's own application. Other terminals, mouse input, and opening links with `o` have not been verified.

## Next

- [How to judge what it shows you](./reviewing)
- [Every CLI command](./cli)
