---
title: Policy and checkpoints
summary: Set how far Ephyra may go, separately for each part of your code. It starts by only watching.
---

The fear with an autonomous system is that it does too much, somewhere you did not expect. Ephyra's answer is that authority is not global. You divide your repository into **areas**, and each area gets its own ceiling. Your docs can land by themselves while your billing code stops and asks at every step.

## Five levels

Each area sits at one of five levels. Higher levels ask you less.

| Level | Ephyra does | You are asked |
|---|---|---|
| **Watch** | Notices and reports. Decisions are recorded but nothing advances. | Nothing is worked. |
| **Research** | Gathers evidence and writes a hypothesis. Changes nothing. | At A, B and C. |
| **Propose** | Reproduces the failure and plans a fix. | At B and C. |
| **Patch** | Writes and proves the fix. | At C, before landing. |
| **Auto-land** | Lands proven small fixes, watches them, rolls back on regression. | Only when something needs you. |

New workspaces start at **Watch**, which is shadow mode: Ephyra shows you what it *would* have decided, and does nothing. Leave an area there until its decisions look right to you, then raise it one step.

> [!TIP]
> Start with one narrow area whose tests you trust, and raise only that. A level is easy to raise later and awkward to regret.

## Risk overrides the level

Every area also has a **risk**: low, medium, high or critical. Risk decides how much proof is required and puts two hard limits on any level:

- **High and critical** changes always need a named person at checkpoint C.
- **Critical** changes are never landed automatically. An Auto-land setting on a critical area is applied as Patch, and the editor tells you.

Risk has to reflect the real blast radius. Labelling payment code "low" does not reduce what could go wrong; it only removes the proof that would have caught it.

## Editing policy in the console

Open **Workspace**. The **application map** shows your areas as cards: a plain-language description, the paths it covers, its risk, whether it is user-facing, and its level. Change a level, or describe a new area in your own words and let Velum propose its settings.

Changes go through three states, and the difference matters:

<!-- steps -->
1. **Draft.** Your edits, saved but not in effect. Experiment freely.
2. **Published.** The reviewed draft written to a policy ref in Git (`refs/ephyra/policy/<draft>`). Still not in effect.
3. **Active.** An approver explicitly activates that publication. Ephyra checks its commit, content digest and the previously active version, then reloads its policy.

Activation changes what Ephyra may do. It does not deploy your application.

When policy changes, unfinished work it affects is invalidated, along with any approval that is now stale. A landing or watch that was already authorized keeps the authority it was recorded with.

If a save or activation has an uncertain outcome, refresh and read its recorded status before repeating it. An operation key identifies the original action, so repeating it is safe once you have looked.

## The file behind the map

The map is a view of `autonomy.md`, which you can also edit directly, in the console or in your repository:

```md
# Autonomy policy

## defaults
mode: shadow
checkpoints: A=blocking B=blocking C=blocking
landing: trail_ref
watch: 2h

## area: documentation
paths: docs/**
risk: low
user_facing: false
Keep documentation accurate without changing application behavior.
```

| Setting | Values | Meaning |
|---|---|---|
| `mode` | `shadow`, `enforce` | Shadow records decisions without acting on them. |
| `checkpoints` | `A=`, `B=`, `C=` each `blocking` or `advisory` | Blocking waits for a person. Advisory records and continues. |
| `landing` | `trail_ref`, `auto_land` | A branch for the quest, or a direct landing. |
| `watch` | A duration such as `2h` | How long to observe after landing. |
| `paths` | Globs | The files this area covers. |
| `risk` | `low`, `medium`, `high`, `critical` | Sets required proof and the limits above. |
| `user_facing` | `true`, `false` | Adds study requirements for riskier changes. |

The prose under an area is its **intent**: what matters about this part of the application. Agents read it as context. It cannot change a setting, and a line of prose that looks like one is escaped when the file is written.

How the levels map onto these settings:

| Level | `mode` | A / B / C | `landing` |
|---|---|---|---|
| Watch | shadow | blocking / blocking / blocking | trail_ref |
| Research | enforce | blocking / blocking / blocking | trail_ref |
| Propose | enforce | advisory / blocking / blocking | trail_ref |
| Patch | enforce | advisory / advisory / blocking | trail_ref |
| Auto-land | enforce | advisory / advisory / advisory | trail_ref, auto_land |

`ephyra init` writes a shadow-mode template into `ephyra/` in a checkout, and `ephyra policy` shows which policy the server has in effect, with any warnings.

## Other policy documents

- **`thresholds.yaml`** holds the confidence a decision model must reach before its answer is used. Thresholds are keyed by the model's exact identity, so swapping models never silently reuses another model's numbers.
- **`intents/*.md`** describe what the application is supposed to do, in prose. Intent probes check them.

## Next

- [What proof each risk level requires](./proof)
- [The console's Workspace screen](./console#workspace)
