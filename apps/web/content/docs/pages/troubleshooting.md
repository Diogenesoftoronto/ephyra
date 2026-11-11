---
title: Troubleshooting
summary: Find your symptom, read the likely cause, do the next step. Start with ephyra doctor.
---

Most problems with Ephyra are one of two things: a connection that is saved but not working, or the system correctly refusing to continue without evidence. Both are reported plainly once you know where to look.

## Start here

```sh
ephyra doctor
```

It checks the server, your sign-in, this repository, the journal refspecs, policy files, the recorded setup and the inbox, and prints the next step for anything that is off. It only reads.

Then, if you want help from your coding agent:

```sh
ephyra handoff --copy
```

That puts a brief on your clipboard with everything `doctor` found, ready to paste.

## Nothing is happening

### No quests appear

A quest needs a signal, and a signal needs somewhere to come from.

1. **Is telemetry connected and observed?** In `ephyra setup`, telemetry should read *observed*, not *configured*. Configured means a key is saved and no event has arrived through it.
2. **Is a repository configured?** On a self-hosted server without `EPHYRA_REPO_URL`, signals are stored but not triaged.
3. **Has anything actually failed?** A quiet application produces no quests. That is the good case.

### Quests appear and stop immediately

With no decision model (`EPHYRA_DECIDE=none`, the default), every signal is routed to a person. Look in the inbox. This is deliberate: Ephyra does not triage without a model you chose.

### Everything is "would have"

The area is in **shadow mode** (level *Watch*). Decisions are recorded and nothing advances. Raise the area's level in **Workspace** when its decisions look right. See [Policy](./policy#five-levels).

### The inbox is empty but I expected something

- The checkpoint may be **advisory** for that area, so it did not wait for you.
- The quest may be **parked**. `ephyra quests --state parked`.
- Someone may have **claimed** the review. It shows as `handed_off`.
- The quest may still be working. `ephyra activity`.

## Setup is blocked

`ephyra setup` lists each blocker with who must act.

| Blocker | Cause | Next step |
|---|---|---|
| Repository | An SSH, `localhost` or private-network URL, or a token without access. | Use the HTTPS URL and a token scoped to the repository. |
| Model access | No key, or the key could not list models. | Add or replace it in **Settings**. |
| Execution | No isolated runner has been granted. | An operator item. On the hosted service, contact us. Self-hosted: [configure a runner](./configuration#agents-and-execution). |
| Checks | No test command was found, or it did not run in the runner. | Make sure the repository's tests run from a clean checkout. |
| Telemetry | No project, or nothing has arrived. | Connect a scoped PostHog project and trigger an event. |
| Deployment | No receipt URL, or it does not match the repository, branch or commit. | [Publish a deployment receipt](./landing-watch#publish-a-deployment-receipt). |

## A quest is parked

Open the quest. The reason is in its activity.

| Reason | What it means | What to do |
|---|---|---|
| Could not reproduce | The agent could not write a check that fails. | Comment with what you know about how to trigger it, then resume. Or kill it. |
| Attempts exhausted | Proof failed repeatedly. | Read the last proof bundle. The patch or the hypothesis is wrong; send it back from the right checkpoint or kill it. |
| Budget reached | Tokens, time or spend hit the ceiling. | See [Budgets](./budgets). The operator can raise a limit. Resuming does not reset the count. |
| Unknown cost | A provider returned no cost and this workspace requires one. | Use a provider that reports cost. |
| Paused | A person parked it. | Resume when ready. |
| Waiting on a parent | A related quest must land first. | It resumes by itself. |

## A decision was refused

### "Stale decision; refresh before retrying"

The quest changed after you opened it: a new revision, a new commit, or new proof. Your answer was not applied. Look again and decide on what is there now. This is the system working.

### "Read-only here"

You are signed in, and not an approver in this workspace. The owner can change your role under **Team**. `ephyra whoami` shows your access.

If you are using a service token: once sign-in is configured, the token can read but cannot make a human decision. Use `ephyra login`.

### "A person holds this review"

Someone claimed it. They release it (`u` in the terminal, `ephyra release`), then it can be decided.

## A quest will not land

- **Proof is incomplete.** Read the missing items in the bundle. A required check that did not run is a blocker, not a formality. See [Proof](./proof#missing-is-a-blocker).
- **It needs a named person.** High and critical changes need one at C regardless of policy.
- **It is critical.** Critical changes are never landed automatically. Land it by hand after approving.
- **The base moved.** Someone pushed. The quest went back to rebase, and the earlier approval no longer applies.
- **No deployment observer or telemetry coverage.** Ephyra does not start a landing it cannot watch.

## The watch never finishes

The watch needs the deployed commit, the applicable probes and complete telemetry for the whole window. It does not close clean if the receipt URL reports a different commit, PostHog's computation does not reach the end of the window, history was truncated, or a probe is unavailable. Fix the gap; the watch is not counted as quiet in the meantime.

## An operation needs reconciliation

A write to something external (a provider, a forge, a sandbox) got no clear answer. Ephyra does not know whether it happened, so it stopped.

1. `ephyra ops` lists what is waiting.
2. Check the external system directly: did the branch appear, did the VM start, was the charge made?
3. Resolve it according to what you found. Do not simply retry; the first attempt may have succeeded.

## The CLI

| Message | Cause | Next step |
|---|---|---|
| `Not signed in…` | No session, no token. | `ephyra login <server-url>` |
| `EPHYRA_API_TOKEN needs EPHYRA_PRINCIPAL` | A token without a name for the audit log. | Set `EPHYRA_PRINCIPAL`. |
| `sign-in timed out` | The browser approval was not completed in ten minutes. | Run `ephyra login` again and approve the matching code. |
| `API connection failed` | The server could not be reached for a read. | Check `EPHYRA_URL` and the network. Safe to repeat. |
| `API write outcome unknown…` | A write got no answer. | `ephyra show <quest>` first; repeat only if it was not applied. |
| `Quest not found` | No quest has that short id. | `ephyra quests` |
| `Inbox requires a terminal` | `ephyra inbox` was piped. | Use `ephyra inbox --json`. |

If the inbox draws badly in your terminal, try `EPHYRA_ANSI=1 ephyra inbox`.

## The server will not start

The server validates its configuration and names what is wrong.

| Message | Cause |
|---|---|
| A complaint about `EPHYRA_API_TOKEN` | Missing, or shorter than 16 characters. |
| `…must be a bare origin…` | `EPHYRA_PUBLIC_ORIGIN` has a path or trailing slash. |
| `EPHYRA_DRAFT=anthropic requires …` | A provider was selected without its key. |
| `/healthz` returns 503 | The durable store is unreachable. Check `CONVEX_URL` and that `EPHYRA_CONVEX_SECRET` matches on both sides. |

`ephyra status` shows `memory` when no durable store is configured. In that mode state is lost on restart; see [Self-hosting](./self-hosting#stage-2-keep-state).

## Still stuck

Collect `ephyra doctor --json` and `ephyra setup --json` before asking for help. Neither contains a credential. Security issues go to the contact in [`security.txt`]({{site}}/.well-known/security.txt), not a public channel.
