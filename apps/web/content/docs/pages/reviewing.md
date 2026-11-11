---
title: How to judge a checkpoint
summary: What each checkpoint is asking, what to read before you answer, and what your answer commits you to.
---

The hard part of supervising an agent is not pressing approve. It is knowing, in two minutes, whether you should. Each checkpoint shows you one thing and asks one question. This page is what to look for.

## Before any of them

- **You are approving a specific revision.** The inbox shows the revision, commit and proof your answer is bound to. If the quest moves on first, your answer is refused and you look again.
- **Read the evidence, not just the summary.** The summary was written by the same agent whose work you are checking. In the console open the evidence; in the terminal press `e`.
- **"Unavailable" is not "passed".** A source or check Ephyra could not reach is listed as missing. Decide whether you can judge without it.
- **Sending it back is normal.** `revise` with a note returns the quest one stage and the agent works on what you wrote. It costs budget, not trust.

## A · Is this the right cause?

You see `hypothesis.md`: what the agent thinks is wrong and why, with the triage that started the quest.

Ask:

- **Does the cause explain the signal?** A hypothesis should account for the actual error and stack trace, not something nearby.
- **Is the evidence observed?** Look for specifics: a commit, a line, a log entry, a trace. "Probably" and "likely" without a source is a guess.
- **Is this already being worked?** Triage lists duplicates it considered.
- **Is it even a bug?** Sometimes the signal is expected behavior. Reject, and the quest ends there.

Approve when you would be content for someone to spend an hour on this cause. Send it back with what it missed. Reject if it should not be worked at all.

## B · Does the test fail for the right reason?

You see the failing reproduction and `plan.md`.

This is the checkpoint people skim and should not. A reproduction that fails for the *wrong* reason will happily pass after a patch that fixes nothing.

Ask:

- **Does the failure match the hypothesis?** Read the failure output. It should be the reported problem, not a missing import or a typo in the test.
- **Would the test have caught the original report?** If it only covers one currency, one locale or one path, say so now.
- **Is the plan the repair you would make?** Check which files it intends to touch and whether that stays inside the area's intent.
- **Is the plan smaller than the problem?** A plan that rewrites a module to fix an off-by-one deserves a note.

## C · Does this exact revision fix it?

You see the diff and the proof bundle. Approving C is what lands the quest.

Ask:

- **Reproduction: failed before, passes after.** Both halves must be there. "Passes after" alone proves only that the test passes.
- **Tests: what ran, and what did not.** The bundle records the command and its result.
- **Diff scope: is anything outside the plan?** Files you did not expect are the first thing to question.
- **Review findings.** A second agent reviewed the patch. Read what it flagged, including what it decided was fine.
- **Missing items.** For riskier changes the bundle needs more: probes, visual differences, a replay, a study. Anything required and absent is listed. See [Proof requirements](./proof).

> [!WARNING]
> For changes rated **high** or **critical**, a named person must approve C; policy cannot waive it. A **critical** change is never landed automatically: after you approve, landing is a separate, manual step.

## Spend requests

Occasionally a quest asks to spend money: a study with real respondents for a high-risk, user-facing change. You see the purpose and the amount.

Approving starts the run. Declining records your decision and the quest continues without that evidence, which may leave it unable to satisfy its proof. No proof is inferred from either answer.

## Questions from an investigation

An investigation can stop and ask you a factual question: what a field means, whether a behavior is intended. It shows why it is asking and what a useful answer looks like.

Answer with what you know. Your answer is recorded with your name as context for the quest. It cannot grant a permission or stand in for a check.

## Your options, side by side

| Action | Effect | Terminal | CLI |
|---|---|---|---|
| **Approve** | The quest continues. At C, it lands. | `a` | `ephyra decide <quest> C approve` |
| **Send back** | Returns one stage, with your note. | `r` | `ephyra decide <quest> C revise -m "…"` |
| **Reject** | Ends the quest. | | `ephyra decide <quest> A reject` |
| **Comment** | Adds a note; changes nothing else. | `c` | `ephyra comment <quest> -m "…"` |
| **Claim** | Holds the review for you. | `t` | `ephyra claim <quest>` |
| **Release** | Gives the review back. | `u` | `ephyra release <quest>` |
| **Park** | Pauses where it is. | `p` | `ephyra park <quest>` |
| **Kill** | Stops for good, with a reason. | `x` | `ephyra kill <quest> -m "…"` |

In the console the same actions are buttons on the quest, in the Loop and the Inbox.

## Claiming a review

On a team, two people can open the same checkpoint. Claiming it marks it yours: nobody else can decide it, and workflow actions are refused while it is held. Comments still work.

A claim does not pause the agent. Work already queued, such as a proof run, carries on. Release the review before you decide.

## When you are not sure

Ask **&Tutor** on the quest, if your operator has enabled it. It explains the reproduction, patch and proof in plain language and cites the records it used. It cannot approve anything.

Or comment with your doubt and leave the checkpoint. A blocking checkpoint waits as long as you need, and waiting does not use execution budget.

## Next

- [Reduce how often you are asked](./policy)
- [What proof is required, and why](./proof)
