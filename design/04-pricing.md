# 04 · Pricing and legal

Decision date: 12 November 2026. Currency: USD.

## Product decision

Ephyra is a prepaid usage business. Customers fund their own balance; **$150 is a suggested starting balance**, not a free welcome grant, required minimum or monthly fee. There is no required subscription, per-seat fee or per-quest charge.

The customer buys model use and compute. Public pricing should name those stable categories and explain the service charge without requiring customers to understand the internal architecture or the current model catalog. Exact provider/model identities stay in internal receipts and detailed usage records for reconciliation and evaluation.

The hosted credit product remains a proposal, not an available checkout or entitlement. `apps/web/src/pricing.ts` is the shared source for `/pricing` and `llms.txt`; keep `status: "proposed"` and `billingImplemented: false` visible. Unpublished rates are `null`, never zero.

## Charges

| Category | What it covers | Decision still needed |
|---|---|---|
| Model usage | Monitoring, investigation, coding, review and verification requests | Underlying model cost plus a consistent percentage; percentage not yet set |
| Hosting and compute | Resources, execution time, storage, network and retained environments | Resource units, idle charges, rounding and published rates |
| Data-use option | Explicit training permission at the lower price; no-training at a higher price | Price difference and consent/enforcement implementation |
| ZDR processing | Separately assessed hosting and provider configuration | Contact sales; scoped agreement and technical verification required |
| Customer-funded balance | Prepaid funds consumed as work runs | Checkout, payment fees, taxes, expiry/refunds and settlement rules |

The model service charge is a **consistent percentage of underlying model cost**, not a fixed price per operation. The percentage remains undecided; do not publish the earlier 5% as an agreed rate. At the same usage and percentage, lower underlying model prices produce lower customer model charges. The billing cost basis must say how discounts, caching, credits and rebates are allocated; an arbitrary frozen list price must not silently defeat that pass-through. Changing the underlying model should not require rewriting plan names; rate changes still need a clear effective date and auditable rate version.

Proposed model charge = eligible model cost × (1 + service percentage). Hosting and compute are separate items, followed by any disclosed data-use option adjustment and applicable taxes. Preserve microusd precision and a versioned rounding rule. A constant markup percentage preserves relative markup, not absolute revenue: as model cost falls, the markup dollars fall too. Measure hosting, support, verification, idle capacity and payment costs before claiming sustainability. Do not fund unmetered hosting on an assumption that model markup will always cover it.

Model work and compute still cost money when a quest is abandoned, fails verification or is rolled back. There is no extra reward for landing an unproven fix. Customer-owned provider accounts are billed by those providers; their treatment under the hosted service charge remains to be decided.

The earlier $1.50 worked-quest fee, 30 included sandbox minutes, $0.02/min overflow, $20 free allowance and free hosted open-source allocation are superseded proposals. They are not launch commitments.

## Spending controls and cost explanation

The current console shows recorded spend, costs by work and engine, individual receipts, unknown costs, per-quest budgets and optional on-demand spend forecasts. Forecasts are estimates and do not authorize spending. Model allowances do not by themselves cap cloud compute costs.

The intended hosted experience adds:

- one prepaid balance and an itemized view of model usage, compute and service charges;
- account/workspace spending limits and per-quest limits;
- warnings before the balance or spending allowance is exhausted;
- optional automatic top-ups with a customer-set amount and maximum;
- permission for Ephyra to allocate work within the customer's chosen limits;
- estimated cost ranges before expensive work, with actual charges and uncertainty afterward.

### Agentic forecasts without model-specific product names

The existing spend forecast is an on-demand service over recorded complete-day usage.
Extend that through capability-based interfaces for classification and forecasting;
Jev and Clairic are possible internal implementations, not names of customer plans.
Keep exact returned identities and evaluation versions in receipts. Provider changes
must trigger capability and calibration checks, never an invisible fallback.

Add estimated **time to a verified fix**, distinct from time to a patch and the
configured watch window. Report a range, update it as repro/proof/retry evidence
arrives, and explain what changed. Separate active compute from queue time, external
dependencies, human waits and watch duration. Include unresolved/failed quests as
censored or failed outcomes so successful fixes alone do not bias the estimate.
When history is insufficient, show that fact instead of a precise invented ETA.

Benchmark estimates against held-out observed outcomes: interval coverage, error,
cost overrun and changes in accuracy by task type and model identity. Do not label
a model's self-reported confidence as calibrated. Forecasts inform the agent's
choice of checks and work allocation within the existing envelope; they do not
raise spend limits, purchase credits or expand authority by themselves. Automatic
refreshes must have their own bounded cadence, cost and idempotency rules.

## Training permission and retention options

Product direction: a lower-price training-permitted option, a higher-price
no-training option, and a sales-led ZDR configuration. Prices remain unpublished.
No training pipeline, consent setting, price differential or ZDR capability is
activated by this proposal. Existing content remains outside training use.

Training requires a separate, affirmative and recorded choice by someone with
authority over the selected content. Specify allowed repositories and artifact
classes, purposes, recipients, retention and withdrawal behavior. Repository text,
an agent action, public availability, ordinary service access or a billing change
does not grant training rights. Record consent revision and provenance on eligible
datasets; recheck before collection/export/use and stop future use after withdrawal.
Explain treatment of previously trained weights before consent rather than promising
unlearning that the system cannot perform. Keep pricing changes transparent when
the customer changes options; no retrospective repricing or retroactive consent.

An organization connecting telemetry may not control all personal information or
third-party code within it. Define eligible content, exclude secrets and unnecessary
personal data, and establish the required authority for any secondary use. Review
the consent/pricing arrangement before launch against applicable law; a checkbox
does not establish rights the customer lacks. See the Canadian privacy regulator's
[meaningful consent guidance](https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/appropriate-handling-of-personal-information/collecting-personal-information-and-consent/consent/gl_omc_201805/).

No-training and zero retention are separate. The former controls model training;
the latter needs a defined scope across inference providers, logs, caches, backups,
telemetry and our own services. Ephyra normally keeps git evidence and operation
records, so never advertise blanket zero retention while retaining that content.
Sales must agree which payloads are transient, which customer-owned artifacts and
minimal billing/security metadata remain, and which routes can enforce that scope.
Disable incompatible routes/features for that configuration. See, for example,
[provider-specific ZDR limits](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention).

Account credit billing, automatic top-ups and aggregate monthly spending controls are not established by the current usage page. The pricing page must call these planned until their settlement and enforcement paths are implemented and verified.

## Before publishing rates

Measure a representative set of monitoring-only, short repair, long investigation, verification-heavy and repeated-recovery workloads. Record model costs, compute, storage, idle resources and payment fees separately. Include unsuccessful work. Report a range and workload assumptions rather than promising a number of fixes or compute hours for $150.

Choose the service charge after examining these costs, then publish a versioned rate card. Confirm the wallet provider's reservation/settlement behavior, ambiguous outcomes, concurrent jobs, refunds, top-up idempotency and combined model/compute limits before calling the billing product available.

## Verification status

The public pricing route and machine-readable summary share this proposal. Local tests check that unpublished rates remain unknown, that hosted billing stays marked unavailable, and that the $150 balance is customer-funded. This is copy and contract coverage, not payment, browser, hosted provider or production billing verification.

## Legal pages

The pages are `/legal/terms`, `/legal/privacy`, `/legal/acceptable-use`, `/legal/providers`, `/security` and `/.well-known/security.txt`. Their bodies are in `apps/web/content/legal/*.html`. The operator details are filled in from `OPERATOR` in `apps/web/src/legal.ts`.

They follow the form of the user's Not Organic terms:
- a review copy that is not yet effective;
- the same operator: a sole proprietor in Québec;
- Québec law, no arbitration and no liability cap;
- Québec French-language provisions.

They also add what is specific to Ephyra:
- autonomy and checkpoint responsibility;
- unverified evidence is never reported as passed;
- Radicle replication cannot be recalled;
- the cookie inventory of the public site and sign-in;
- self-hosted operators are responsible for their own deployments.

Before adoption: legal review, a public business mailing address, a working contact mailbox (`ephyra@notorganic.info`), a French edition, and a retention schedule for signals and inbox data.
