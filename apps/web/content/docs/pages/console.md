---
title: The web console
summary: What each screen is for, the keys that drive it, and where to look when you have a specific question.
---

The console is where you see everything at once. Open it at [`/app/`]({{app}}) on your Ephyra server. If you are deciding where to look, start from the question you have:

| Your question | Screen |
|---|---|
| Does anything need me right now? | **Loop** |
| What exactly am I being asked to approve? | **Inbox** |
| What is the agent doing, and what did it actually run? | **Runs** |
| What has this cost, and is anything near its limit? | **Usage** |
| What is Ephyra allowed to do in my code? | **Workspace** |
| Who else can see or approve? | **Team** |
| Is my repository, model or telemetry connected? | **Settings** and **Setup** |

## Loop

The home page. Every quest the server holds, where each one is, and the one thing, if any, that needs a person. It refreshes by itself: every two seconds while something is moving, every five when nothing is, and not at all while the tab is hidden.

Select a quest to see what it is waiting for. When it needs you, one primary action is offered: approve, send back, resume, or answer a question.

| Key | Does |
|---|---|
| `j` `k` | Walk the quests |
| `a` then `Enter` | Go to the waiting action, then press it |
| `i` | Open "under the hood": the quest's journal, events and files |
| `Esc` | Close it |

> [!TIP]
> Approving takes two keys on purpose. `a` moves focus to the action and `Enter` presses it, so a stray keystroke never approves anything.

## Inbox

The list of decisions waiting on a person, and for each one the thing you are asked to judge: the hypothesis at checkpoint A, the reproduction and plan at B, the diff and proof bundle at C, or a spend request. It shows the revision, commit and proof your decision will be bound to.

If your account is read-only, or the quest changed after the page loaded, the decision buttons are unavailable and the page says why. [How to judge a checkpoint](./reviewing) covers what to look for.

The inbox also holds setup questions: what your application should do, and which connections are missing. Answering those early gives every later quest better context.

## Runs

Every agent step is a **run**: research, reproduction, planning, patching, review. The list shows which step, which engine, where it executed and how it ended. Open one to read its transcript: the agent's messages, each tool call with its (redacted, truncated) arguments and result, and every **policy decision** where Ephyra's rules allowed, rejected or modified a tool call.

A running transcript updates live, and resumes from where it was if your connection drops.

> [!TIP]
> When a patch surprises you, read the run that wrote it before you read the diff. The transcript shows what the agent looked at and what it was refused.

## Usage

Totals for the last 7 or 14 days, spend by day, and breakdowns by persona, engine and quest, with each quest's budget beside what it has used. Below that is a filterable ledger of every recorded entry.

Unknown prices stay unknown. If a provider did not report a cost, the entry is counted separately and the total is labelled a lower bound. [Budgets and usage](./budgets) explains the limits.

## Workspace

Where you say what Ephyra may do. It holds the **application map** (your code as named areas, each with an autonomy level) and the documents behind it: `autonomy.md`, `thresholds.yaml` and the files in `intents/`.

Editing always happens in a **draft**. You can edit the text directly, adjust the map, or ask **Velum**, the drafting assistant, to propose a change, which you review before applying. Then:

<!-- steps -->
1. **Publish** writes the reviewed draft to a policy ref in Git. Nothing changes yet.
2. **Activate**, a separate approver action, puts that exact published content into effect for this workspace.

Activation reloads Ephyra's policy. It does not deploy your application. Unsaved edits block publishing and switching views, so you cannot publish something other than what you are looking at. [Policy](./policy) explains the levels.

## Personas

Six named roles do the work: **Rho** listens for signals, **Bell** researches, **Nema** proves, **Lappet** mends, **Turri** watches and **Velum** drafts policy. They are roles, not models. The page shows which engine each one actually used, what it is doing, and what it has spent.

## Team

Invite people with a single-use link and choose **Viewer** or **Approver** for each. Viewers see everything and can decide nothing. Invitations can be revoked. Only the workspace owner manages the team.

## Settings and Setup

**Settings** holds the repository connection, model access, telemetry, knowledge sources and people to contact. **Setup** shows the recorded setup run: each step, the coverage table and the blockers. [Workspace connections](./connections) describes each connection.

## Getting around

| Key | Does |
|---|---|
| `⌘K` or `Ctrl K` | Open the command menu |
| `?` | Open it and see every shortcut |
| `g` then `l` `o` `i` `r` `u` `w` `p` `t` `s` | Go to Loop, Overview, Inbox, Runs, Usage, Workspace, Personas, Team, Settings |

The **Help** button in the top bar opens help for the screen you are on: what it is for, a few tips, the matching page here, and a brief you can copy for your coding agent. A one-line tip also appears above each screen; **Got it** moves to the next, and **Hide tips** in the help menu turns them off.

## Tutor and voice

On a quest, **&Tutor** explains the recorded reproduction, patch and proof in plain language and asks one question to check your understanding. Its answers cite the records they came from and are marked stale if the quest has moved on. It has no tools and cannot approve or change anything.

Voice lets you talk through recorded work and dictate policy drafts. Both features need the operator to configure a provider, and both report their usage.

## Try it without an account

`/app/?demo=1` opens the console on a fictional quest with adapters that never contact a server. The [home page]({{site}}/) walks through the same sample. Sample data is labelled as such everywhere it appears.

## Next

- [Decide from the terminal instead](./terminal)
- [The same information from the CLI](./cli)
