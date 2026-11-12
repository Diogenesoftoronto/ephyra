# 04 · Pricing and legal

Decision date: 12 November 2026. Currency: USD.

## Product decision

Ephyra is a prepaid usage business. Customers fund their own balance; **$150 is a suggested starting balance**, not a free welcome grant, required minimum or monthly fee. There is no required subscription, per-seat fee or per-quest charge.

The customer buys model use and compute. Public pricing should name those stable categories and explain the service charge without requiring customers to understand the internal architecture or the current model catalog. Exact provider/model identities stay in internal receipts and detailed usage records for reconciliation and evaluation.

The hosted credit product remains a proposal, not an available checkout or entitlement. `apps/web/src/pricing.ts` is the shared source for `/pricing` and `llms.txt`; keep `status: "proposed"` and `billingImplemented: false` visible. Unpublished rates are `null`, never zero.

## Charges

| Category | What it covers | Decision still needed |
|---|---|---|
| Model usage | Monitoring, investigation, coding, review and verification requests | Metered unit prices and a consistent service charge on model usage |
| Compute | Resources and execution time for application environments and checks | Resource units, rounding and published rates |
| Customer-funded balance | Prepaid funds consumed as work runs | Checkout, payment fees, taxes, expiry/refunds and settlement rules |

A consistent service charge is the current direction. Whether it is a fixed amount per billing unit or a percentage of usage, and its value, remain undecided. Do not publish the earlier 5% as an agreed rate. Do not imply one flat total price for arbitrarily large model requests. Changing the underlying model should not require rewriting the plan names; rate changes still need a clear effective date and auditable rate version.

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
