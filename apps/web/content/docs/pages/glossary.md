---
title: Glossary
summary: The words Ephyra uses, in plain language, with the name you will see in code where it differs.
---

Ephyra has a small vocabulary, and a few of its words mean something narrower than they do elsewhere. If a screen or a page uses a term you are not sure of, it is here. Search finds them too.

## Words you meet first

**Quest**
One repair, recorded from signal to close. Called a *trail* in API paths, ref names and JSON.

**Signal**
Something that suggests a problem: an exception, a failing trace, a report. Signals with the same *fingerprint* are grouped.

**Checkpoint**
A place where a person may be asked. **A** reviews the hypothesis, **B** the plan, **C** the patch and its proof.

**Blocking / advisory**
A blocking checkpoint waits for a person. An advisory one records the question and carries on.

**Inbox**
What is waiting on a person: checkpoints, spend requests, parked quests, questions.

**Approver / Viewer**
An approver can decide checkpoints. A viewer can read everything and decide nothing.

**Area**
A named part of your repository, defined by path globs, with its own risk and autonomy level.

**Autonomy level**
How far Ephyra may go in an area without asking: Watch, Research, Propose, Patch, Auto-land.

**Shadow mode**
Decisions are recorded and nothing advances. The Watch level.

## The repair

**Hypothesis**
What research believes is wrong and why. The file `hypothesis.md`.

**Reproduction (repro)**
A check that fails because of the problem. It must fail before the patch and pass after.

**Plan**
The intended repair. The file `plan.md`.

**Revision**
A numbered attempt at the fix. A quest that is rolled back, or revised by a person, moves to the next revision.

**Head / base**
The commit of the patch, and the commit it was built on.

**Proof bundle**
The list of evidence for one revision: reproduction, tests, diff scope and whatever the risk requires. Its SHA-256 *digest* identifies its exact contents.

**Bound**
The revision, head and proof digest a decision applies to. A decision whose bound no longer matches is *stale*.

**Probe**
A small check run on demand. A *regression probe* is a past reproduction kept after a clean close. An *intent probe* checks that the application does what an intent says.

**Intent**
A prose description of what part of the application is supposed to do. Files in `intents/`.

**Risk**
Low, medium, high or critical. Sets the proof required and limits what may land automatically.

## After the fix

**Landing**
Writing the reviewed commit to the repository. A *quest ref* landing writes a branch (`trail_ref`); *auto-land* writes to the base branch.

**Watch**
Observing the deployment for a set window after landing.

**Deployment receipt**
A URL you provide that reports which commit is deployed.

**Rollback**
Undoing a landing after a regression, in a new commit.

## States

**Parked**
Stopped with a reason, and resumable.

**Handed off**
A person has claimed the review.

**Abandoned**
Killed or rejected. Final.

**Closed**
Landed, watched, clean. Final.

## Under the hood

**Journal**
A quest's history in Git, at `refs/ephyra/trails/<id>/journal`.

**Event**
A fact about a quest: an agent finished, a person approved, a watch saw a regression.

**Effect**
Something a transition asks to happen. A request, not evidence that it happened.

**Operation key (idempotency key)**
A stable identifier for one side effect, so a repeat is recognized as the same operation.

**Operation ledger**
The durable record of which effects were started and how they ended.

**Reconciliation**
Checking an external system by hand because a write's outcome is unknown.

**Projection**
A copy of quest state in the durable store, kept for fast reads.

**Worker lease / fencing**
One worker owns a workspace at a time; a replaced worker cannot keep acting.

**Unverified**
Tested against a contract or a fake, and not exercised against the live service. Also the error raised when an integration cannot be verified.

**Untrusted content**
Text that came from outside: logs, traces, comments, answers. Always data, never instructions.

## People and parts

**Persona**
One of six named roles: Rho listens, Bell researches, Nema proves, Lappet mends, Turri watches, Velum drafts.

**Engine**
The exact backend identity that did a piece of work, as it reported itself.

**Run**
One agent step, with its transcript.

**Runner**
Where an agent's code executes.

**Forge**
Where the repository lives: plain Git over HTTPS, Radicle, Tangled.

**Not Organic**
The identity provider used to sign in, and one source of hosted models.

**Velum**
The persona that helps draft policy in the console's Workspace.

**&Tutor**
An explainer on a quest. It reads the records and cannot act.

**Control plane**
The Ephyra server, as distinct from this documentation site.
