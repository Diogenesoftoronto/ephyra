# 04 · Pricing and legal

Decision date: 7 November 2026. Currency: USD. Status: the self-hosted price and the model pass-through are facts. **The hosted plan is a proposal**, not a live checkout, entitlement or contract. The numbers live in one typed object, `apps/web/src/pricing.ts` (`pricing`). Its `status: "proposed"` and `billingImplemented: false` flags must stay visible wherever the numbers are shown. Tests compare the `/pricing` page's `data-*` values with that object.

## What Macroscope does (checked 7 November 2026)

Sources: `macroscope.com/pricing.md`, `docs.macroscope.com/legacy-pricing`, `app.macroscope.com/terms` (updated 20 October 2026), `app.macroscope.com/privacy` (updated 4 November 2026), and `macroscope.com/security/llm.txt`.

- **Usage-based, prepaid, no seats.** Each workspace has one balance with auto-refill, a monthly budget, and per-review and per-PR caps. When the balance runs out, work pauses, and skipped commits may not be processed later.
- **Code review** is $0.05 per KB of diff in the default Balanced mode, with a 10 KB minimum. The other modes cost $0.025 (Budget), $0.06 (Precise) and $0.20 (Ultra) per KB.
- **Status** is $0.05 per commit.
- **Agent** is $0.01 per credit: raw model cost plus 5%, with 1,000 free credits per month.
- **$100 of free usage** for every new workspace, instead of a trial.
- **Free credits for non-commercial open source.** In exchange, Macroscope's terms (4.1) let it train on those projects' source code.
- **History.** Macroscope retired its earlier plan, $30 per active developer per month, in March and April 2026. Its stated reason: "Seats are no longer a useful proxy" once agents write the code.
- **Legal.** The Terms are under California law with binding AAA arbitration and a class-action waiver. Liability is capped at 12 months of fees, and only the customer indemnifies. Customer source code is not used for training except for open-source partners. Macroscope holds SOC 2 Type II. Fifteen or so subprocessors are named on its trust page, mostly model providers.

## What Ephyra keeps and changes

| Macroscope | Ephyra | Why |
|---|---|---|
| Usage-based, no seats | Same | Approvers are the product's safety mechanism. A seat price would push teams toward fewer approvers. |
| Price per KB of diff reviewed | **Price per worked trail** (a trail that runs at least one agent step) | The trail is Ephyra's unit of work. Charging per *landed* fix would reward landing, but Ephyra should abandon an unprovable trail just as readily. |
| Agent at model cost + 5% | Hosted agent at provider cost + 5%; **your own agent account at no markup** | Most teams already pay for Amp, Claude or Codex. Double-charging them would be the easiest way to lose them. |
| Model usage inside the per-KB price | Triage at Not Organic's rates with **no Ephyra margin** | Listening has to stay nearly free for Ephyra to watch everything. The route gates spending, not the price of listening. |
| $100 free | $20 free (proposed) | Pre-alpha, with no hosted operations yet. Raise it once a trail's real cost is measured. |
| Open source: free credits, code may be trained on | Free hosted trails, **never trained on** | Ephyra trains on nobody's code. |
| Closed source; hosted only | **Self-hosted is free** and complete | Self-hosting is the core idea. |
| Arbitration, class waiver, 12-month cap | None of these; Québec law; consumer rights intact | Matches the user's Not Organic terms, and Québec consumer law limits arbitration clauses anyway. |

## Proposed hosted numbers

| Item | Proposed price | Notes |
|---|---:|---|
| Worked trail | $1.50 | Includes 30 sandbox minutes. Trails that stop at triage (duplicates, muted, abandoned) pay only model usage. |
| Extra sandbox time | $0.02/min | |
| Hosted agent turns | provider cost + 5% | Only when the customer uses our agent account. |
| Triage models | Not Organic rates | Clairic extraction $0.10 per million input tokens; Jev judgement $0.0609 per million input tokens, output not charged. Read from the Not Organic gateway configuration on 7 November 2026. |
| Starting usage | $20 | |
| Open source | free worked trails | For non-commercial projects; limits set per project. |

**Unit economics (assumptions to check before launch).** Assume a 2 vCPU, 4 GB sandbox for 30 minutes, at Railway list prices of $20 per vCPU-month and $10 per GB-month. That compute costs about $0.06. Most of the $1.50 then covers Convex, storage, the inbox, monitoring, support and payment fees.

These figures have not been measured. Before launch:
- measure real trail duration, retries and storage growth;
- measure the real support time per trail;
- confirm Not Organic's payment fees;
- check that 30 included minutes covers most proof runs.

If proof runs are long, raise the included minutes rather than the headline price.

**Open decisions for the operator.** The hosted prices, the starting credit, the open-source eligibility rules, the open-source licence (the landing pages say "to be decided"), and whether checkout runs through Not Organic's Paddle merchant of record.

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
