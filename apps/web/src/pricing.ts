// Public pricing proposal shared by /pricing and llms.txt. This is not a billing rate card.
// Unknown rates stay null; no numeric zero may imply free hosted usage.

export type Rate = { label: string; usd: number | null; unit: string; note?: string; display?: string };
export type Plan = {
  id: "self-hosted" | "hosted";
  name: string;
  status: "available" | "proposed";
  price: string;
  summary: string;
  includes: string[];
  rates?: Rate[];
};
export type Pricing = {
  checked: string;
  currency: "USD";
  billingImplemented: false;
  startingBalanceUsd: number;
  plans: [Plan, Plan];
  faq: ReadonlyArray<readonly [string, string]>;
};

export const pricing: Pricing = {
  checked: "2026-11-12",
  currency: "USD",
  billingImplemented: false,
  startingBalanceUsd: 150,
  plans: [
    {
      id: "self-hosted", name: "Self-hosted", status: "available", price: "$0 licence fee",
      summary: "Run Ephyra on your own infrastructure. You pay for the models and compute you use.",
      includes: [
        "Unlimited quests, repositories and collaborators",
        "Investigation, proof, landing and watch",
        "Connect supported models and coding agents with your own account",
        "Recorded usage and per-quest budgets",
      ],
    },
    {
      id: "hosted", name: "Hosted credits", status: "proposed", price: "Pay for usage",
      summary: "Prepay for model use and compute. No required monthly subscription, seat fee or per-quest charge. Proposed; not for sale yet.",
      includes: [
        "A customer-funded balance, with $150 suggested to start",
        "Model usage for monitoring, investigation, coding and verification",
        "Compute for running your application and its checks",
        "A consistent service charge on model usage; rate to be announced",
      ],
      rates: [
        { label: "Model usage", usd: null, unit: "", display: "Rates to be announced",
          note: "Usage charges plus the published service charge, without tying the plan to a particular model." },
        { label: "Compute", usd: null, unit: "", display: "Rates to be announced",
          note: "Based on the resources and execution time used." },
      ],
    },
  ],
  faq: [
    ["Is the $150 starting balance free credit?", "No. It is a suggested customer-funded starting balance, not a welcome grant or a monthly fee."],
    ["What happens when a quest does not produce a fix?",
      "The model work and compute it used still count. There is no separate fee for starting a quest or landing a fix."],
    ["How will I control spending?",
      "The hosted proposal includes spending limits, balance warnings and optional automatic top-ups within a limit you choose. "
      + "Those billing controls are not available yet. The current console shows recorded spend and per-quest budgets."],
    ["How do I understand the cost?",
      "Usage shows recorded spend, work history and quest budgets. Unknown costs are labelled separately. "
      + "Published rates and an itemized billing breakdown will explain hosted charges before purchase."],
    ["What does self-hosting cost?", "There is no Ephyra licence fee. Hosting, model providers and other services you connect charge separately."],
    ["Can I buy hosted credits?", "Not yet. The structure is a proposal; unit rates and the service charge are still being set. "
      + "Checkout will show prices, the seller and terms before anything is charged."],
  ],
};

/** At least two decimals for fractional amounts, preserving the rate's precision. */
export const money = (usd: number) => `$${usd.toFixed(Math.max(2, (String(usd).split(".")[1] ?? "").length)).replace(/\.00$/, "")}`;
const priced = (r: Rate) => r.display ?? (r.usd === null ? "Rate to be announced" : `${money(r.usd)} ${r.unit}`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function rateRows(rates: readonly Rate[], plan: string): string {
  return rates.map((r) => {
    const note = r.note ? `<br><span class="muted">${esc(r.note)}</span>` : "";
    return `<tr data-plan="${plan}" data-rate="${esc(r.label)}" data-usd="${r.usd ?? "unannounced"}">`
      + `<td>${esc(r.label)}</td><td><strong>${esc(priced(r))}</strong>${note}</td></tr>`;
  }).join("");
}

/** The /pricing page body. */
export function pricingBody(p = pricing): string {
  const cards = p.plans.map((plan) => `<section class="plan" id="${plan.id}" data-plan="${plan.id}" data-status="${plan.status}">
<p class="tag">${plan.status === "proposed" ? "Proposed · not for sale" : "Available now"}</p>
<h2>${esc(plan.name)}</h2><p class="price">${esc(plan.price)}</p><p>${esc(plan.summary)}</p>
<ul>${plan.includes.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
${plan.rates ? `<table><tbody>${rateRows(plan.rates, plan.id)}</tbody></table>` : ""}
</section>`).join("");
  return `<h1>Pricing</h1>
<p class="lede">Pay for model use and compute. Start with a prepaid balance and spend it as Ephyra works.</p>
<p>The hosted proposal below is not for sale yet. Self-hosting is available now.</p>
<div class="plans">${cards}</div>
<h2 id="models">Understand your usage</h2>
<p>Model use covers monitoring, investigation, coding and verification. Compute covers the resources used to run your application and its checks. \
The hosted proposal adds a consistent service charge to model usage; the rate has not been set.</p>
<p>We suggest ${money(p.startingBalanceUsd)} as an initial customer-funded balance. How long it lasts depends on your workload, \
check duration and retries. We have not measured a representative number of hours or fixes for that amount.</p>
<p>The <a href="/docs/budgets">Usage guide</a> explains recorded spend, per-quest budgets and forecasts. \
Hosted balance warnings, account spending limits and optional automatic top-ups are planned.</p>
<h2 id="faq">Questions</h2>
<dl class="faq">${p.faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join("")}</dl>
<p class="muted">Prices are in ${p.currency}, before taxes. Hosted credit billing is not implemented, and nothing on this page is an offer. \
See the <a href="/legal/terms#charges">Terms of Service</a>.</p>`;
}

/** Lines for llms.txt. */
export function pricingSummary(p = pricing): string[] {
  const [self, hosted] = p.plans;
  return [
    `- Self-hosted: $0 licence fee. ${self.summary}`,
    `- Hosted plan (proposed, not for sale): prepaid model usage and compute; no required subscription, seat fee or per-quest charge.`,
    `- Suggested starting balance: ${money(p.startingBalanceUsd)}, customer-funded, not a free grant.`,
    `- Hosted rates: ${(hosted.rates ?? []).map((r) => `${r.label}: ${priced(r)}`).join("; ")}. Service charge not yet set.`,
    `- Recorded usage and per-quest budgets are available. Hosted balance warnings and automatic top-ups are planned.`,
  ];
}
