---
title: Landing and watch
summary: How an approved fix reaches your repository, how Ephyra confirms it reached production, and what happens if the problem comes back.
---

A merged fix is not a fixed bug. The patch might not be deployed, the deployment might be a different commit, or the error might return an hour later. Ephyra treats landing as the middle of the job and stays to see what happens.

## How a fix lands

| Mode | What is written | When |
|---|---|---|
| **Quest ref** (`trail_ref`) | A branch, `ephyra/<quest-id>`, holding the exact reviewed commit. | The default. You merge it the way you merge anything. |
| **Auto-land** (`auto_land`) | The reviewed commit, directly onto the base branch. | Only for areas whose [policy](./policy) allows it, and never for critical risk. |

Either way the write is **conditional**: it succeeds only if the remote ref is still where Ephyra last saw it. If someone pushed in the meantime, nothing is overwritten. The quest goes back to patching to rebase, and the earlier approval no longer applies.

The standard personal workflow writes over HTTPS with your account's repository authority. Landing also requires a deployment observer and telemetry coverage, because a landing nobody can watch is not one Ephyra will start.

> [!NOTE]
> Native Radicle and Tangled proposal writes are host integrations, not part of the stock hosted path. Closing a proposal is also not the same as reverting deployed code, so on those forges landing and rollback need an explicit strategy.

## Publish a deployment receipt

Ephyra needs to hear from your deployment which commit is live. Expose a public HTTPS endpoint that returns it:

```json
{
  "schema": 1,
  "repository": "https://git.example.org/team/application.git",
  "branch": "main",
  "commit": "FULL_SHA1_OR_SHA256_COMMIT",
  "deployedAt": "2026-11-08T12:00:00.000Z"
}
```

- The repository, branch and full commit must match the saved connection and the commit that was landed.
- `commit` and `deployedAt` must come from the deployment that actually happened. Most platforms expose the commit as a build-time variable.
- The URL must have no embedded credentials, query string or fragment. Ephyra sends it no credentials.

Save the URL under telemetry in **Settings**.

## What the watch observes

Once the landed commit is confirmed deployed, the watch runs for the window your policy sets (two hours by default). It needs three things for the whole window:

- the deployed commit,
- the probes that apply to the change,
- complete, attributed telemetry.

PostHog's computation has to cover both the history the watch asked for and the end of the window. Fetching an old cached result does not make its observations new.

## What ends a watch

| Outcome | What it means | What happens |
|---|---|---|
| **Clean** | The window passed with full coverage and no regression. | The quest closes. Its reproduction is registered as a regression probe. Quests that were waiting on it resume. |
| **Regression** | The problem, or a new one attributed to the change, appeared. | The landing is rolled back. The quest reopens at the next revision, with what the watch saw as evidence. |
| **Cannot tell** | A missing deployment, stale computation, truncated history or unavailable probe. | No clean close. The gap is reported. |

"Cannot tell" is the important row. An incomplete watch is not counted as a quiet one.

## Rollback

A rollback restores the previous tree in a new conditional commit, or removes the branch a quest-ref landing created. It never force-pushes over someone else's work.

Rollback and regression actions keep their own operation receipts. If a remote write's outcome is uncertain, Ephyra stops and marks it for reconciliation instead of trying again. See [troubleshooting](./troubleshooting#an-operation-needs-reconciliation).

## Next

- [Limits on what a quest can spend](./budgets)
- [How landing looks in the state machine](./lifecycle)
