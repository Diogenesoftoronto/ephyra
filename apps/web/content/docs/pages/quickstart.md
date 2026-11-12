---
title: Quickstart
summary: Connect a repository, choose how much you want to review, and read what setup found. About ten minutes.
---

By the end of this page Ephyra will know your repository, you will know what it can and cannot observe yet, and nothing will have been changed in your code.

**You need:** a Git repository reachable over HTTPS (GitHub, GitLab, Forgejo or any public HTTPS smart-Git endpoint), and a [Not Organic]({{site}}/legal/providers) account to sign in with. For a private repository you also need a token scoped to that repository.

## 1. Sign in

Open [the application]({{app}}) and choose **Sign in with Not Organic**. This creates your personal workspace. Nothing is connected yet.

## 2. Connect a repository

Paste the repository's HTTPS URL. Setup discovers the default branch. For a private repository, add the scoped token here; it is stored on the server and never shown again, written to a journal or sent to a model.

> [!TIP]
> Use the HTTPS address even if you normally clone over SSH. Hosted setup does not accept SSH URLs, `localhost` or private-network addresses. If your repository is only reachable inside your network, [run Ephyra yourself](./self-hosting).

## 3. Choose how to review

You are asked for one thing: **Autonomous** or **Supervised**.

- **Supervised** makes every checkpoint blocking and lands fixes as a branch for you to merge. Ephyra stops at the hypothesis, at the plan and at the patch, and waits for you each time. Choose this if you are deciding whether to trust it.
- **Autonomous** is the default. Checkpoints are advisory and proven fixes may land directly, so work continues without you as long as its proof is complete.

Either way, a fix lands only with the proof its risk requires. Changes rated high or critical always need a named person at the last checkpoint, and critical changes are never landed automatically. Both modes start with one area covering the whole repository; you can split it and set each part differently later. See [Policy](./policy#where-you-start).

## 4. Read what setup found

Setup inspects the pinned commit, prepares configuration, looks for the checks your repository already has, and records what it can observe. It is a recorded run, so you can leave and come back.

The result is a list of steps and a coverage table. Each part of the loop gets one of four words, and the difference between the first two matters:

| Word | What it means |
|---|---|
| **Observed** | Ephyra has seen this actually happen. |
| **Configured** | A connection is saved, but nothing has been seen through it yet. |
| **Missing** | A connection or capability the loop needs is absent. |
| **Unknown** | There is not enough evidence to say. |

A saved telemetry key is *configured*. It becomes *observed* when an event arrives through it.

## 5. Deal with the blockers

A connected repository is the first step, not the last. Before a repair can run end to end, the workspace also needs:

- **Model access**, hosted through Not Organic or your own key. → [Connections](./connections#models-and-execution)
- **An isolated runner** for the agent to work in. The host grants this.
- **Checks that actually run** in that runner: your tests, at minimum.
- **Somewhere signals come from**: a scoped PostHog project, or OTLP. → [Connections](./connections#telemetry)
- **A deployment receipt**, so Ephyra can tell that the commit it landed is the one in production. → [Landing and watch](./landing-watch)

Setup lists each missing piece with who has to act: you (the *maintainer*) or whoever runs the server (the *operator*). On the hosted service, operator items are ours.

> [!TIP]
> From a terminal, `ephyra setup` prints the same steps, coverage and blockers, and `ephyra doctor` checks your machine and repository as well. [Install the CLI](./cli#install).

## What you have now

Setup prepares `autonomy.md`, `thresholds.yaml` and `intents/application.md`, plus verification, evidence and recovery configuration. Existing policy in your repository is kept. The generated prose and the commands it discovered are a starting point: they still have to be seen working.

Until a signal arrives, the loop is quiet. That is normal. The inbox may already hold a few questions about what your application is supposed to do; answering them before the first incident is the most useful thing you can do next.

## Next

- [Understand what a quest goes through](./concepts)
- [Learn how to judge a checkpoint](./reviewing)
- [Decide what Ephyra may do, area by area](./policy)
