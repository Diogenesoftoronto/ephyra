---
title: Budgets and usage
summary: Every quest has a ceiling on tokens, money and time. What the defaults are, why a quest stopped, and how to stop one yourself.
---

An agent in a loop can spend without limit and tell you afterwards. Ephyra gives every quest three ceilings, counts against them cumulatively, and refuses to treat a cost it does not know as zero.

## Three ceilings per quest

| Ceiling | Server setting | Default |
|---|---|---|
| Reported tokens | `EPHYRA_TRAIL_TOKENS` | 2,000,000 |
| Execution time | `EPHYRA_TRAIL_WALLCLOCK_S` | 14,400 seconds (4 hours) |
| Metered inference spend | `EPHYRA_TRAIL_SPEND_MICROUSD` | 0: no metered allowance |

Three things about how they count:

- **Retrying does not reset them.** A quest that fails proof and patches again is still spending from the same budget.
- **Waiting is free.** Time at a checkpoint is not execution time.
- **Spend defaults to nothing.** The operator has to choose a metered allowance on purpose.

When a ceiling is reached, active work stops and the quest parks with the reason.

## Unknown costs

Some providers answer a request without saying what it cost. Ephyra records that entry as **unknown cost**. It is counted separately and never added to the total as zero, so a total with unknown entries is labelled a lower bound.

| Workspace | When a required cost is unknown |
|---|---|
| Personal | The quest stops. Always. |
| Deployment | Continues by default; `EPHYRA_REQUIRE_KNOWN_COST=true` makes it stop. |

> [!WARNING]
> A working key of your own does not mean costs are reported. If your personal quests stop with an unknown-cost reason, that provider is not returning a reconciled cost. Use a hosted model, or a provider that reports cost.

## Reading usage

**Usage** in the console, or `ephyra usage` in a terminal, shows totals for the window, spend by day, and breakdowns by engine and by quest with each quest's budget beside it. `ephyra usage --days 30` widens the window. Engines are recorded by the exact identity the backend returned.

## Spend forecasts

When the operator has configured a Clairic route, **Forecast spend** in Usage requests daily spend estimates for 7, 14 or 30 days. It runs only when you ask and is metered like other model work. With no configured route, the page says **Not configured**.

The history uses 28 complete UTC days. Today's partial day and entries with unknown cost are excluded. The chart labels the forecast separately from recorded spend, reports the exact model identity and shows the provider's daily p10–p90 ranges when available. Those daily ranges are not a probability interval for the whole period. A forecast does not raise a budget or authorise spending.

If the outcome is not confirmed, **Check saved forecast** reuses its original request key, history dates and horizon, including after navigation or UTC midnight. It retrieves the saved result or reports uncertainty instead of creating another paid request. **Leave unresolved** does not establish whether the provider charged; check the Usage ledger.

## What a budget does not cover

- **Sandbox resources are separate.** A model allowance does not cap what a cloud VM costs.
- **CLI agents report after the fact.** An agent CLI that exposes no token cap cannot be held to one mid-run. Its usage is recorded when the step ends.
- **A step has its own timeout**, 30 minutes by default (`EPHYRA_STEP_TIMEOUT_S`).

## Stopping a quest

| You want to | Do | Effect |
|---|---|---|
| Pause it | Park (`p`, or `ephyra park`) | Stops where it is. Resume continues from the same state. |
| End it | Kill (`x`, or `ephyra kill -m "…"`) | Aborts active work and tries to destroy its runner. Final. |

A stop receipt says which of three things happened to the runner: destruction confirmed, an allocation still pending, or cleanup uncertain. If it is uncertain, check your provider; Ephyra does not claim a machine is gone when it could not confirm it.

## Recovery

One worker owns a workspace at a time. If it is replaced, the old one cannot carry on under the new one's authority, and work it left unfinished is not blindly repeated. Operations whose outcome is pending or ambiguous wait for reconciliation, so a restart never duplicates a provider call or a remote write. `ephyra ops` shows what is waiting.

## Next

- [Why a quest parked](./troubleshooting#a-quest-is-parked)
- [Server settings in full](./configuration)
