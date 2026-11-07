// Ephyra's pricing, as one typed object the /pricing page, llms.txt and tests all read.
// Self-hosting and model pass-through are facts. The hosted plan is a proposal: `status: "proposed"` and
// `billingImplemented: false` must stay visible wherever it is shown. design/04-pricing.md explains the numbers.

/** A priced unit. `display` replaces the dollar figure for pass-through rates such as "Provider cost + 5%". */
export type Rate = { label: string; usd: number; unit: string; note?: string; display?: string };
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
  /** [extraction, judgement] */
  models: [Rate, Rate];
  example: { signals: number; extractionTokens: number; judgementTokens: number };
  /** [self-hosted, hosted] */
  plans: [Plan, Plan];
  faq: ReadonlyArray<readonly [string, string]>;
};

export const pricing: Pricing = {
  checked: "2026-11-07",
  currency: "USD",
  billingImplemented: false,
  /** Not Organic's operator-set rates for the hosted System One calls Ephyra makes (gateway configuration, checked above). */
  models: [
    { label: "Extraction (Clairic, via Not Organic)", usd: 0.10, unit: "per million input tokens" },
    { label: "Judgement (Jev, via Not Organic)", usd: 0.0609, unit: "per million input tokens", note: "Output tokens are not charged." },
  ],
  /** Illustrative triage batch, using the per-signal token assumptions in design/01-product-and-loop.md §5. */
  example: { signals: 1000, extractionTokens: 2000, judgementTokens: 3000 },
  plans: [
    {
      id: "self-hosted", name: "Self-hosted", status: "available", price: "$0",
      summary: "The whole of Ephyra on your own Railway, devenv or hardware. Open source; licence being chosen.",
      includes: [
        "Unlimited trails, repositories and approvers",
        "Checkpoints A, B and C, proof, landing and watch",
        "Radicle, Tangled, plain git and Sapling",
        "Any decision and extraction model: Not Organic, your own keys, or d1 and Clef on your own GPU",
        "Any coding agent: Amp, Claude Code or Codex, on your own account",
      ],
    },
    {
      id: "hosted", name: "Hosted", status: "proposed", price: "Usage, no seats",
      summary: "We run Ephyra for you, billed from a prepaid Not Organic balance. Proposed; not for sale yet.",
      includes: [
        "Everything in Self-hosted, operated by us",
        "Unlimited approvers and repositories; no per-seat fee",
        "Triage at Not Organic model rates with no Ephyra margin",
        "Triage-only signals (duplicates, muted, abandoned) cost model usage only",
        "Bring your own agent account at no markup, or use a hosted agent",
        "$20 of usage to start; free hosted trails for non-commercial open-source projects",
      ],
      rates: [
        { label: "Worked trail", usd: 1.5, unit: "per trail", note: "A trail that runs at least one agent step. Includes 30 sandbox minutes." },
        { label: "Extra sandbox time", usd: 0.02, unit: "per minute" },
        { label: "Hosted agent turns", usd: 0, unit: "per turn", display: "Provider cost + 5%",
          note: "Only when you use our agent account instead of your own." },
      ],
    },
  ],
  faq: [
    ["Why no seats?", "Approvers are the point of Ephyra. Charging for each one would push teams to approve with fewer people."],
    ["Why charge per worked trail, not per landed fix?",
      "A per-landing price would reward landing. Ephyra should be just as willing to abandon a trail it cannot prove."],
    ["What does self-hosting really cost?", "No licence fee, but you pay for your own hosting, models, agent accounts and operations."],
    ["Is my code used to train models?", "No. The Privacy Policy explains how model providers handle requests."],
    ["Can I buy the hosted plan?", "Not yet. The hosted numbers are a proposal. Checkout will show the price, seller and terms before anything is charged."],
  ],
};

/** $0, $0.10, $0.0609, $1.50, $20: at least two decimals below a dollar, and as many as the rate has. */
export const money = (usd: number) => `$${usd.toFixed(Math.max(2, (String(usd).split(".")[1] ?? "").length)).replace(/\.00$/, "")}`;
const priced = (r: Rate) => r.display ?? `${money(r.usd)} ${r.unit}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Triage cost for the example batch at the current model rates, rounded up to the cent. */
export function exampleTriageUsd(p = pricing): number {
  const [extraction, judgement] = p.models;
  const { signals, extractionTokens, judgementTokens } = p.example;
  const usd = (signals * extractionTokens * extraction.usd + signals * judgementTokens * judgement.usd) / 1e6;
  return Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;
}

function rateRows(rates: readonly Rate[], plan: string): string {
  return rates.map((r) => {
    const price = r.display ? `<strong>${esc(r.display)}</strong>` : `<strong>${money(r.usd)}</strong> ${esc(r.unit)}`;
    const note = r.note ? `<br><span class="muted">${esc(r.note)}</span>` : "";
    return `<tr data-plan="${plan}" data-rate="${esc(r.label)}" data-usd="${r.usd}"><td>${esc(r.label)}</td><td>${price}${note}</td></tr>`;
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
  const [extraction, judgement] = p.models;
  const ex = p.example;
  const total = exampleTriageUsd(p);
  return `<h1>Pricing</h1>
<p class="lede">Self-hosting is free. The models you choose bill per call. A hosted plan is proposed below; it isn’t for sale yet.</p>
<div class="plans">${cards}</div>
<h2 id="models">Hosted models</h2>
<p>On any plan, hosted judgement and extraction are billed to the Not Organic account the deployment bills, at Not Organic’s rates. \
Not Organic sets those rates and can change them. The rates below were checked on ${esc(p.checked)}.</p>
<table><tbody>${rateRows(p.models, "models")}</tbody></table>
<p>For example, triaging ${ex.signals.toLocaleString("en")} unique signals, at about ${ex.extractionTokens.toLocaleString("en")} extraction tokens \
and ${ex.judgementTokens.toLocaleString("en")} judgement tokens each, costs about <strong data-example-usd="${total}">${money(total)}</strong> \
(${money(extraction.usd)} and ${money(judgement.usd)} per million). Duplicate signals are merged before any model call. Your own keys bill you \
at your provider’s price. Models on your own hardware cost only the hardware.</p>
<p>The largest cost is usually the coding agent. A trail’s agent turns are billed by Amp, Anthropic or OpenAI to the account you connect.</p>
<h2 id="faq">Questions</h2>
<dl class="faq">${p.faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join("")}</dl>
<p class="muted">Prices are in ${p.currency}, before taxes. Billing is not implemented, and nothing on this page is an offer. \
See the <a href="/legal/terms#charges">Terms of Service</a>.</p>`;
}

/** Lines for llms.txt. */
export function pricingSummary(p = pricing): string[] {
  const [self, hosted] = p.plans;
  return [
    `- Self-hosted: $0. ${self.summary}`,
    `- Hosted models (Not Organic, checked ${p.checked}): ${p.models.map((r) => `${r.label} ${priced(r)}`).join("; ")}.`,
    `- Hosted plan (proposed, not for sale): ${(hosted.rates ?? []).map((r) => `${r.label} ${priced(r)}`).join("; ")}.`,
  ];
}
