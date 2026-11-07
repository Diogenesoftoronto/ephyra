// Legal and trust pages: Terms, Privacy, Acceptable Use, Service Providers and Security, plus security.txt.
// Bodies live in content/legal/*.html with {{placeholders}} for operator details, so one config changes every page.
// They are review copies, prepared in the same form as Not Organic's own terms, and say so on every page.
import { join } from "node:path";

export type Operator = {
  /** Legal name of the person or company operating the site and hosted services. */
  name: string;
  /** How the operator is described in the documents, e.g. "a sole proprietor in Québec, Canada". */
  description: string;
  /** General and privacy contact. */
  email: string;
  /** Vulnerability reports. Defaults to `email`. */
  securityEmail?: string;
};

export const OPERATOR: Operator = {
  name: "Keith Abiola Noel",
  description: "a sole proprietor in Québec, Canada",
  email: "ephyra@notorganic.info",
};

export const REVISED = "2026-11-07";

export type LegalDoc = { path: string; file: string; title: string; summary: string; glance?: string[] };

export const LEGAL_DOCS: LegalDoc[] = [
  {
    path: "/legal/terms", file: "terms.html", title: "Terms of Service",
    summary: "Your rights and responsibilities when you use Ephyra’s website and the deployments we operate.",
    glance: [
      "Your code and content stay yours. Model output needs your review.",
      "You choose what Ephyra may do alone. You own what you approve.",
      "We don’t train models on your code.",
      "Self-hosting is free. Nothing is for sale yet.",
      "Your mandatory consumer rights stay intact.",
    ],
  },
  {
    path: "/legal/privacy", file: "privacy.html", title: "Privacy Policy",
    summary: "What Ephyra processes for the website, sign-in, production signals, trails and model calls.",
    glance: [
      "The public pages use no analytics, advertising or cookies.",
      "Sign-in goes through Not Organic. Ephyra stores your DID, handle and an encrypted session.",
      "Model providers receive the signal excerpts and code a request needs.",
      "Approvals are recorded by DID, because a checkpoint’s purpose is a reviewable record.",
      "You can ask for access, correction and deletion.",
    ],
  },
  {
    path: "/legal/acceptable-use", file: "acceptable-use.html", title: "Acceptable Use Policy",
    summary: "What Ephyra may be pointed at, and the safeguards you must leave in place.",
  },
  {
    path: "/legal/providers", file: "providers.html", title: "Service providers",
    summary: "The services that may process information for Ephyra, what they receive, and where.",
  },
  {
    path: "/security", file: "security.html", title: "Security",
    summary: "How to report a vulnerability, how Ephyra protects sessions, secrets and approvals, and its known limits.",
  },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const mailto = (email: string) => `<a href="mailto:${esc(email)}">${esc(email)}</a>`;

/** Replace {{operator}}, {{operatorName}}, {{contact}} and {{security}}. Unknown placeholders are an error, never left in a page. */
export function fill(body: string, op: Operator = OPERATOR): string {
  const values: Record<string, string> = {
    operator: `${esc(op.name)}, ${esc(op.description)}`,
    operatorName: esc(op.name),
    contact: mailto(op.email),
    security: mailto(op.securityEmail ?? op.email),
  };
  return body.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown legal placeholder {{${key}}}`);
    return value;
  });
}

/** The review notice every legal page carries until a lawyer has reviewed it and the operator adopts it. */
export function reviewNotice(op: Operator = OPERATOR): string {
  return `<p class="notice" role="note"><strong>Prepared for review, not yet effective.</strong> The operator is ${esc(op.name)}, `
    + `${esc(op.description)}. A public business mailing address, legal review and a French edition must be completed before adoption.</p>`;
}

/** Full body for one legal page: title, revision, notice, at-a-glance list, contents and the document. */
export async function legalBody(doc: LegalDoc, contentDir: string, op: Operator = OPERATOR): Promise<string> {
  const body = fill(await Bun.file(join(contentDir, doc.file)).text(), op);
  const headings = [...body.matchAll(/<h2 id="([a-z0-9-]+)">([^<]+)<\/h2>/g)];
  const toc = headings.length > 2
    ? `<nav class="toc" aria-label="Contents"><ol>${headings.map(([, id, text]) => `<li><a href="#${id}">${text}</a></li>`).join("")}</ol></nav>` : "";
  const glance = doc.glance ? `<section class="glance"><h2>At a glance</h2><ul>${doc.glance.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`
    + "<p class=\"muted\">This summary is a guide to the full text below.</p></section>" : "";
  return `<p class="back"><a href="/legal/">← Legal</a></p><h1>${esc(doc.title)}</h1><p class="lede">${esc(doc.summary)}</p>`
    + `<p class="muted">Revised <time datetime="${REVISED}">${REVISED}</time> · Review copy</p>${reviewNotice(op)}${glance}${toc}${body}`;
}

/** The /legal/ index. */
export function legalIndex(): string {
  return `<h1>Legal</h1><p class="lede">The documents that govern Ephyra’s website and the deployments we operate.</p>${reviewNotice()}`
    + LEGAL_DOCS.map((d) => `<article class="post"><h2><a href="${d.path}">${esc(d.title)}</a></h2><p>${esc(d.summary)}</p></article>`).join("")
    + `<article class="post"><h2><a href="/pricing">Pricing</a></h2><p>What self-hosting, models and the proposed hosted plan cost.</p></article>`;
}

/** RFC 9116 security.txt. `Expires` is one year after the revision date. */
export function securityTxt(origin: string, op: Operator = OPERATOR): string {
  const expires = new Date(Date.parse(`${REVISED}T00:00:00Z`) + 365 * 86400_000).toISOString();
  return [
    `Contact: mailto:${op.securityEmail ?? op.email}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en, fr",
    `Policy: ${origin}/security`,
    `Canonical: ${origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}
