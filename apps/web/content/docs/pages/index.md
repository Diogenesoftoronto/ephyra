---
title: Ephyra documentation
summary: Production errors become reviewed, proven repairs on a repository you own. Start from the problem you have.
---

You run software that people use, and it breaks faster than you can attend to it. An error fires at night; by morning it is one line in a list of forty. You would hand the easy ones to an agent, but not if that means an unreviewed change landing on `main` with a green tick nobody can explain.

Ephyra is built for that gap. It takes a production signal and works it as a **quest**: it gathers evidence, states a hypothesis, writes a test that fails for that reason, patches, proves the patch, lands it and watches the deployment. You decide how far it may go alone, area by area. Where you want a say, it stops and asks, and shows you exactly what it is asking you to judge.

> [!NOTE]
> Ephyra is pre-alpha. These pages describe what the software does today. Where something needs configuration you may not have, or is not built yet, the page says so.

## Start from your problem

<!-- cards -->
- **[I want to try it on my repository](./quickstart)** Sign in, connect a repository over HTTPS and read what setup found. About ten minutes.
- **[I would rather my coding agent set it up](./agent-setup)** One prompt to paste. The agent asks for scoped access; you approve it.
- **[Something is waiting on me and I do not know how to judge it](./reviewing)** What each checkpoint asks, what to read, and what approving commits you to.
- **[I am nervous about what it can do to my code](./policy)** Authority is set per area of your repository, and it starts in shadow mode.
- **[It is stuck, refused something, or shows nothing](./troubleshooting)** Symptoms, what causes them, and the next step.
- **[I want to run it on my own machines](./self-hosting)** A local server in two commands, then durable state and sign-in.

## Hand this to your agent

Everything here is also published as Markdown for coding agents. Paste this into Claude Code, Codex, Amp or whichever agent you use:

```prompt
Read {{docs}}/agent.md and help me set up Ephyra for this repository. Tell me what you find before you change anything, and ask me for whatever only I can decide.
```

Every page has **Copy page for an agent** at the top, and its own address with `.md` on the end. If you have the CLI, `ephyra handoff` prints a brief with your server, repository and current problems already filled in. [More on working with an agent](./agent-setup).

## Three ways to use it

| | Best for | Start |
|---|---|---|
| **Web console** | Seeing every quest at once, editing policy, reading agent transcripts, inviting teammates | [The console](./console) |
| **Terminal inbox** | Deciding checkpoints from the keyboard without leaving your shell | [The terminal inbox](./terminal) |
| **CLI** | Scripts, CI, quick lookups, and diagnosing a setup with `ephyra doctor` | [The CLI](./cli) |

They are three views of one server. A decision made in one shows up in the others.

## What a quest goes through

<!-- loop -->
1. **Signal** A reported problem
2. **Evidence** What was observed
3. **Hypothesis** A · you may review
4. **Repro** A check that fails
5. **Plan** B · you may review
6. **Patch** A candidate fix
7. **Proof** C · you may review
8. **Landing** An authorized write
9. **Watch** The deployment, observed

[Quests, checkpoints and proof](./concepts) explains each stage. [How it works](./architecture) explains the machinery underneath.

## What Ephyra will not do

It does not report a check that did not run. A missing integration is shown as missing, an unknown cost as unknown, and an unverifiable result stops the quest instead of passing it. That rule shapes most of what you will read here, and [the trust model](./trust) sets it out.
