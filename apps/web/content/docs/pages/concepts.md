---
title: Quests, checkpoints and proof
summary: The handful of ideas everything else is built on. Read this once and the screens make sense.
---

A normal bug-fix process has an invisible middle. Something breaks, a pull request appears, and what happened in between lives in someone's head. Ephyra makes the middle the product: every repair is a recorded sequence you can stop, inspect and replay.

## A quest is one repair, recorded

A **quest** starts from a **signal**: an exception, a failing trace, a report. It then moves through fixed stages, and each stage leaves a file behind.

<!-- loop -->
1. **Signal** A reported problem
2. **Evidence** What was observed
3. **Hypothesis** `hypothesis.md`
4. **Repro** A check that fails
5. **Plan** `plan.md`
6. **Patch** A candidate fix
7. **Proof** `proof/manifest.json`
8. **Landing** An authorized write
9. **Watch** The deployment, observed

The quest's history lives in Git, under `refs/ephyra/` in your repository, so it goes wherever the repository goes. [What is stored in Git](./journal) shows how to read it with plain `git`.

> [!NOTE]
> You will see the word **trail** in API paths, ref names and JSON (`/v1/trails`, `trailId`). A trail and a quest are the same thing. "Quest" is the name in the interface; "trail" is the older name the code still uses.

## Triage decides whether it is a quest at all

Not every signal deserves work. Triage sends a signal one of five ways: fix it (`auto_fix`), research it without changing anything (`research_only`), send it to a person (`human`), ignore it and mute that fingerprint for 24 hours (`ignore`), or attach it to a quest that is already working the same problem.

With no decision model configured, every signal goes to a person. That is the default, and it is deliberate.

## Three checkpoints, three questions

A checkpoint is a place where a person may be asked. Each asks a different question:

| Checkpoint | Comes after | The question |
|---|---|---|
| **A · Hypothesis** | Research | Is this the right cause, and is the evidence for it real? |
| **B · Plan** | A failing reproduction | Does the test fail for the reason the hypothesis gives, and is this the repair you want? |
| **C · Patch** | Proof | Does this exact revision fix it, and is the proof complete? |

Whether a checkpoint *stops and waits* is up to your policy. A **blocking** checkpoint holds the quest until a person answers. An **advisory** one records the question and carries on. [Policy](./policy) sets this per area of your code.

An approval is **bound** to the revision, the commit and the proof that were on screen. If the quest moves on before your answer arrives, the answer is refused as stale instead of being applied to something you did not read.

[How to judge a checkpoint](./reviewing) goes through each one.

## Proof is a list of things that happened

Before checkpoint C, Ephyra assembles a **proof bundle**. Every repair needs three things: the reproduction failing before the patch and passing after, test results, and the scope of the diff. Riskier or user-facing changes need more: regression probes, a review, visual differences, a traffic replay, a study with real people.

The rule that matters: an item is in the bundle only if it ran. A missing probe, an absent study or an unavailable check is listed as a blocker. It is never quietly counted as passed. [Proof requirements](./proof) has the full table.

## Landing, then watching

Approving C (or policy allowing it) leads to **landing**: writing the exact reviewed commit to your repository. The usual landing is a branch named for the quest, which you merge the way you merge anything else. Where policy allows, a small low-risk fix can land directly.

After landing comes the **watch**. Ephyra confirms the commit actually reached production, then observes telemetry and probes for a set window. If the problem comes back, the quest is rolled back and reopened at the next revision with what the watch saw. If the window passes clean, the quest closes, and its reproduction is kept as a regression probe for the future.

[Landing and watch](./landing-watch) covers what that needs from you.

## Where a quest can stop

| State | What happened | What to do |
|---|---|---|
| **Waiting at a checkpoint** | A blocking checkpoint needs a person. | Decide it. |
| **Parked** | It could not continue: it could not reproduce, ran out of attempts, hit a budget, or someone paused it. | Read the reason, then resume or kill it. |
| **Handed off** | A person claimed the review. | Release it, then decide. |
| **Rolled back** | The watch saw a regression. | It reopens by itself at the next revision. |
| **Abandoned** | A person killed it or rejected a checkpoint. | Nothing. This is final. |
| **Closed** | Landed, watched, clean. | Nothing. |

[The quest state machine](./lifecycle) has every state and transition.

## Budgets bound every quest

Each quest has a ceiling on tokens, on metered spend and on execution time. Retrying does not reset them, and waiting at a checkpoint does not consume time. When a ceiling is reached, work stops and the quest parks. [Budgets and usage](./budgets) explains the defaults.

## Next

- [See it in the console](./console)
- [Judge your first checkpoint](./reviewing)
- [The words, in one place](./glossary)
