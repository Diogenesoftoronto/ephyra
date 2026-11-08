// Ephyra's public site: the landing page, the Standard.site blog, and everything crawlers and LLMs read.
// One Bun handler; static files come from site/ (the landing cuts and shared assets).
import { join, normalize } from "node:path";
import {
  articlePath, publicationIdentity, publicOrigin, readPublication, type DocumentRecord, type Fetcher, type Publication,
} from "./standard.ts";
import { LEGAL_DOCS, OPERATOR, legalBody, legalIndex, securityTxt, type Operator } from "./legal.ts";
import { pricingBody, pricingSummary } from "./pricing.ts";
import { DOCS_DESCRIPTION, DOCS_UPDATED, docsBody, docsPlainText } from "./docs.ts";

export type SiteConfig = {
  /** Canonical origin of the public site, e.g. https://ephyra.dev */
  origin: string;
  /** Previous origins and aliases that permanently redirect to the canonical origin. Health checks stay local. */
  redirectOrigins?: string[];
  /** Directory holding the landing cuts (a/, b/, c/, e/) and the shared assets/. */
  root: string;
  /** Which landing cut is the home page at "/". Defaults to "e", the main site. The others stay reachable at /a/, /b/, /c/. */
  home?: HomeCut;
  /** at://did/site.standard.publication/rkey; the blog shows a setup notice without it. */
  publicationUri?: string;
  /** The control-plane origin for the console, agent instructions and owner access management. */
  apiOrigin?: string;
  fetcher?: Fetcher;
  /** Seconds to cache the publication read. */
  cacheS?: number;
  /** Directory holding the legal page bodies. Defaults to apps/web/content/legal. */
  contentDir?: string;
  /** Operator named in the legal pages. Defaults to OPERATOR in legal.ts. */
  operator?: Operator;
};

/** Landing cuts that can be the home page. Cut E ("Immortal") is the main site; the others are earlier explorations. */
export const HOME_CUTS = ["a", "b", "c", "e"] as const;
export type HomeCut = (typeof HOME_CUTS)[number];

const NAME = "Ephyra";
const TAGLINE = "Software that fixes itself.";
const SUMMARY = "Ephyra is open-source, self-hostable self-driving software: production errors become quests that go from "
  + "evidence to a failing repro, a patch, proof and a landing on a forge you own, with humans approving at checkpoints. "
  + "No pull requests, no GitHub required. Pre-alpha.";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const xml = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
const ldJson = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
const excerpt = (p: DocumentRecord) => p.value.description || p.value.textContent.replace(/\s+/g, " ").slice(0, 180);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon",
};

/** Static pages listed in the sitemap and llms.txt. */
const PAGES = [
  { path: "/", title: `${NAME} · ${TAGLINE}`, summary: SUMMARY },
  { path: "/docs", title: `Documentation · ${NAME}`, summary: DOCS_DESCRIPTION },
  { path: "/blog/", title: `${NAME} journal`, summary: "Notes on building self-driving software: quests, proof, jellyware." },
  { path: "/pricing", title: `Pricing · ${NAME}`, summary: "Self-hosting is free; hosted models bill per call; a usage-based hosted plan is proposed." },
  { path: "/legal/", title: `Legal · ${NAME}`, summary: "Terms, privacy, acceptable use, service providers and security." },
  ...LEGAL_DOCS.map((d) => ({ path: d.path, title: `${d.title} · ${NAME}`, summary: d.summary })),
];

export function createSite(config: SiteConfig) {
  const origin = new URL(config.origin).origin;
  const canonicalHost = new URL(origin).host;
  const redirectHosts = new Set((config.redirectOrigins ?? []).map((value) => new URL(publicOrigin(value)).host));
  redirectHosts.delete(canonicalHost);
  const apiOrigin = config.apiOrigin ? new URL(config.apiOrigin) : null;
  if (apiOrigin && (!["https:", "http:"].includes(apiOrigin.protocol) || apiOrigin.username || apiOrigin.password)) {
    throw new Error("apiOrigin must be an HTTP(S) origin without credentials");
  }
  if (apiOrigin?.origin === origin) throw new Error("apiOrigin must point to the control-plane server, not this public site");
  const fetcher = config.fetcher ?? fetch;
  const cacheMs = (config.cacheS ?? 60) * 1000;
  const contentDir = config.contentDir ?? join(import.meta.dir, "../content/legal");
  const operator = config.operator ?? OPERATOR;
  const home: HomeCut = config.home ?? "e";
  if (!HOME_CUTS.includes(home)) throw new Error(`home must be one of ${HOME_CUTS.join(", ")}`);
  if (config.publicationUri) publicationIdentity(config.publicationUri);
  let cache: { at: number; value: Publication } | null = null;

  const text = (body: string, type: string, extra: Record<string, string> = {}, status = 200) =>
    new Response(body, { status, headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=300", ...extra } });
  const notFound = () => text("Not found", "text/plain", { "x-robots-tag": "noindex", "cache-control": "no-store" }, 404);

  async function publication(): Promise<Publication | null> {
    if (!config.publicationUri) return null;
    if (!cache || Date.now() - cache.at > cacheMs) cache = { at: Date.now(), value: await readPublication(config.publicationUri, origin, fetcher) };
    const now = Date.now();
    return { ...cache.value, posts: cache.value.posts.filter((p) => Date.parse(p.value.publishedAt) <= now) };
  }

  /** Posts, or [] when the blog is not configured or the PDS is unreachable (SEO files must still serve). */
  async function postsOrEmpty(): Promise<DocumentRecord[]> {
    try { return (await publication())?.posts ?? []; } catch { return []; }
  }

  /**
   * Landing pages are static files with relative links. At serve time, add what needs the canonical origin:
   * canonical link, og:url, absolute og:image, Twitter card, RSS link and Organization/WebSite JSON-LD.
   * Tags a page already has are left alone. `base` re-roots a cut's relative links when it is served as the home page;
   * `noindex` keeps the alternate cuts out of search results, so only the home page is indexed.
   */
  function seoHead(html: string, canonicalPath: string, opts: { base?: string; noindex?: boolean } = {}): string {
    const url = origin + canonicalPath;
    const has = (pattern: RegExp) => pattern.test(html);
    const tags: string[] = [];
    if (!has(/rel="canonical"/)) tags.push(`<link rel="canonical" href="${esc(url)}">`);
    if (!has(/property="og:url"/)) tags.push(`<meta property="og:url" content="${esc(url)}">`);
    if (!has(/property="og:site_name"/)) tags.push(`<meta property="og:site_name" content="${NAME}">`);
    if (!has(/name="twitter:card"/)) tags.push('<meta name="twitter:card" content="summary_large_image">');
    if (opts.noindex && !has(/name="robots"/)) tags.push('<meta name="robots" content="noindex">');
    if (!has(/application\/rss\+xml/)) {
      tags.push(`<link rel="alternate" type="application/rss+xml" title="${NAME} journal" href="${origin}/blog/feed.xml">`);
    }
    if (!has(/application\/ld\+json/)) {
      const schema = { "@context": "https://schema.org", "@graph": [
        { "@type": "Organization", "@id": `${origin}/#org`, name: NAME, url: `${origin}/`, logo: `${origin}/assets/brand/logo.svg` },
        { "@type": "WebSite", "@id": `${origin}/#website`, name: NAME, url: `${origin}/`, publisher: { "@id": `${origin}/#org` } },
        { "@type": "SoftwareApplication", name: NAME, applicationCategory: "DeveloperApplication", operatingSystem: "Linux",
          description: SUMMARY, url: `${origin}/` },
      ] };
      tags.push(`<script type="application/ld+json">${ldJson(schema)}</script>`);
    }
    // Relative OG images are invalid for crawlers; make them absolute.
    const fixed = html.replace(/(<meta property="og:image" content=")(?!https?:)(?:\.\.\/|\.\/)?([^"]+)"/,
      (_m, pre: string, rel: string) => `${pre}${origin}/${rel.replace(/^\/+/, "")}"`);
    const tagged = tags.length ? fixed.replace(/<\/head>/i, `${tags.join("")}\n</head>`) : fixed;
    if (!opts.base) return tagged;
    // <base> must come before every relative URL in the head, so it goes right after <meta charset>.
    const baseTag = `<base href="${esc(opts.base)}">`;
    return /<meta charset="[^"]*">/i.test(tagged) ? tagged.replace(/(<meta charset="[^"]*">)/i, `$1${baseTag}`)
      : tagged.replace(/<head>/i, `<head>${baseTag}`);
  }

  /**
   * A file under the site root. A directory without its trailing slash redirects to it, so a cut's relative links resolve.
   * `asHome` serves a cut's folder at "/", with that folder as the base for its relative links.
   */
  async function staticFile(path: string, asHome = false): Promise<Response | null> {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.(\/|\\|$))+/, "");
    if (rel.includes("..") || rel.split("/").some((part) => part.startsWith(".") && part !== ".")) return null;
    let file = Bun.file(join(config.root, rel));
    if (rel.endsWith("/") || !(await file.exists())) {
      const index = Bun.file(join(config.root, rel, "index.html"));
      if (!(await index.exists())) return null;
      if (!rel.endsWith("/")) return Response.redirect(`${origin}/${rel}/`, 308);
      file = index;
    }
    const ext = /\.[a-z0-9]+$/i.exec(file.name ?? "")?.[0]?.toLowerCase() ?? "";
    if (ext === ".html") {
      const html = asHome ? seoHead(await file.text(), "/", { base: `/${rel.replace(/index\.html$/, "")}` })
        : seoHead(await file.text(), ("/" + rel).replace(/index\.html$/, ""), { noindex: true });
      return new Response(html, { headers: { "content-type": TYPES[".html"]!, "cache-control": "no-cache" } });
    }
    const immutable = rel.startsWith("assets/");
    // Unversioned code and fixtures must not survive a deployment beside newer HTML.
    const revalidate = [".js", ".css", ".json"].includes(ext);
    return new Response(file, { headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": revalidate ? "no-cache" : immutable ? "public, max-age=86400" : "public, max-age=300",
    } });
  }

  function robots(): string {
    return [
      "User-agent: *", "Allow: /", "Disallow: /healthz", "",
      `Sitemap: ${origin}/sitemap.xml`, "",
      "# LLM-readable summaries", `# ${origin}/llms.txt`, `# ${origin}/llms-full.txt`, "",
    ].join("\n");
  }

  async function sitemap(): Promise<string> {
    const posts = await postsOrEmpty();
    const urls = [
      ...PAGES.map((p) => `<url><loc>${xml(origin + p.path)}</loc></url>`),
      ...posts.map((p) => `<url><loc>${xml(origin + "/blog" + p.value.path)}</loc><lastmod>${new Date(p.value.publishedAt).toISOString()}</lastmod></url>`),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`;
  }

  async function llms(full: boolean): Promise<string> {
    const posts = await postsOrEmpty();
    const lines = [
      `# ${NAME}`, "", `> ${TAGLINE} ${SUMMARY}`, "",
      "Ephyra turns production signals into Git-backed quests: evidence, a failing reproduction, a patch, proof, landing and watch.",
      "Accounts use Not Organic identities; the executable stores durable runtime state in Convex and journals in Git.",
      "Setup defaults to autonomous operation, with supervised checkpoints available. High and critical changes require named-human review.",
      "Personal HTTPS landing, isolated execution, model access, study sources and telemetry each need explicit configuration.",
      "Native forge proposal transports, remote Amp verification and respondent dispatch require host integrations.", "",
      "## Agent setup",
      "An agent can discover scoped setup access through auth.md and establish repository context before an incident.",
      "Owner claims use the intended Not Organic DID, exact repository and explicit bootstrap scopes.",
      "Email service_auth and external provider ID-JAG assertions are unsupported by this DID-bound profile.",
      `- [Agent setup instructions](${origin}/auth.md): Authoritative control-plane registration, claim, token and bootstrap instructions.`,
      `- [Owner agent access](${origin}/agent/access): Review and revoke agent registrations after signing in.`,
      `- [Agent setup guide](${origin}/docs#agent-setup): Observation coverage and proactive owner questions.`, "",
      "## Pages",
      ...PAGES.map((p) => `- [${p.title}](${origin}${p.path}): ${p.summary}`), "",
      "## Pricing",
      ...pricingSummary(),
      `- [Pricing](${origin}/pricing)`, "",
      "## Journal",
      ...(posts.length ? posts.map((p) => `- [${p.value.title.replace(/[\[\]\r\n]/g, " ")}](${origin}/blog${p.value.path}): ${excerpt(p)}`)
        : ["- No articles published yet."]),
      `- [RSS feed](${origin}/blog/feed.xml)`, "",
      "## Optional",
      ...(config.apiOrigin ? [`- [Control plane API health](${config.apiOrigin}/healthz)`] : []),
      `- [Full text for LLMs](${origin}/llms-full.txt)`, "",
    ];
    if (full) lines.push("## Documentation", "", docsPlainText(), "");
    if (full && posts.length) {
      lines.push("## Article text", "");
      for (const p of posts) {
        lines.push(`### ${p.value.title}`, "", `Source: ${origin}/blog${p.value.path}`, `Published: ${p.value.publishedAt}`, "");
        lines.push(p.value.textContent.trim(), "");
      }
    }
    return lines.join("\n");
  }

  async function feed(): Promise<string> {
    const pub = await publication();
    const posts = pub?.posts ?? [];
    const name = pub?.publication.value.name ?? `${NAME} journal`;
    const items = posts.map((p) => `<item><title>${xml(p.value.title)}</title><link>${xml(origin + "/blog" + p.value.path)}</link>`
      + `<guid isPermaLink="false">${xml(p.uri)}</guid><pubDate>${new Date(p.value.publishedAt).toUTCString()}</pubDate>`
      + `<description>${xml(excerpt(p))}</description></item>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>`
      + `<title>${xml(name)}</title><link>${xml(origin + "/blog/")}</link><description>${xml(pub?.publication.value.description ?? SUMMARY)}</description>`
      + `<language>en</language><atom:link href="${xml(origin + "/blog/feed.xml")}" rel="self" type="application/rss+xml"/>${items}</channel></rss>\n`;
  }

  /**
   * Every page that is not a landing cut: journal, pricing, legal, security. It wears cut E's look (the main site):
   * the same tokens and type, water at the top of the page where production is, and the seabed under the footer.
   */
  function page(title: string, description: string, path: string, body: string, head = "", type = "website", wide = false, bodyClass = ""): Response {
    const url = origin + path;
    const nav = ([["/docs", "Docs"], ["/blog/", "Journal"], ["/pricing", "Pricing"], ["/security", "Security"]] as const).map(([href, label]) => {
      const current = path === href ? ' aria-current="page"' : href === "/blog/" && path.startsWith("/blog/") ? ' aria-current="true"' : "";
      return `<a href="${href}"${current}>${label}</a>`;
    }).join("") + '<a href="/app/">Open app ↗</a>';
    return text(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:site_name" content="${NAME}"><meta property="og:type" content="${type}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${origin}/assets/og/og.png"><meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#16212f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#eef3f5" media="(prefers-color-scheme: light)">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml"><link rel="icon" href="/assets/brand/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@50..150,100..900&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,600;1,400&display=swap">
<link rel="alternate" type="application/rss+xml" title="${NAME} journal" href="${origin}/blog/feed.xml">${head}
<style>
:root{--bg:oklch(.975 .012 85);--surface:oklch(.992 .006 85);--ink:oklch(.24 .03 60);--muted:oklch(.45 .03 65);--jelly:oklch(.74 .162 68);
--jelly-deep:oklch(.52 .135 52);--glow:oklch(.55 .11 180);--cherry:oklch(.56 .19 24);--line:oklch(.24 .03 60/.16);--on-jelly:oklch(.2 .03 60);
--water-top:oklch(.955 .02 222);--water-mid:oklch(.968 .014 150);
--font-display:"Anybody","Avenir Next Condensed","Arial Narrow",sans-serif;
--font-body:"Atkinson Hyperlegible Next","Atkinson Hyperlegible",system-ui,sans-serif;
--gutter:clamp(1.25rem,4vw,3rem);color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:oklch(.165 .022 250);--surface:oklch(.2 .026 246);--ink:oklch(.95 .015 85);
--muted:oklch(.74 .025 80);--jelly-deep:oklch(.8 .15 72);--glow:oklch(.86 .13 178);--cherry:oklch(.72 .17 24);--line:oklch(.95 .015 85/.14);
--water-top:oklch(.245 .038 230);--water-mid:oklch(.195 .03 240);color-scheme:dark}}
:root[data-theme="dark"]{--bg:oklch(.165 .022 250);--surface:oklch(.2 .026 246);--ink:oklch(.95 .015 85);--muted:oklch(.74 .025 80);
--jelly-deep:oklch(.8 .15 72);--glow:oklch(.86 .13 178);--cherry:oklch(.72 .17 24);--line:oklch(.95 .015 85/.14);
--water-top:oklch(.245 .038 230);--water-mid:oklch(.195 .03 240);color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-width:320px;color:var(--ink);font:400 1.0625rem/1.6 var(--font-body);overflow-x:clip;display:flex;flex-direction:column;min-height:100svh;
background:linear-gradient(180deg,var(--water-top),var(--water-mid) 14rem,var(--bg) 26rem) no-repeat,var(--bg)}
a{color:inherit;text-decoration-color:var(--jelly);text-decoration-thickness:2px;text-underline-offset:.2em}a:hover{text-decoration-color:var(--jelly-deep)}
:focus-visible{outline:2px solid var(--jelly);outline-offset:3px;border-radius:6px}
.bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem 1rem;min-height:4rem;
padding:env(safe-area-inset-top) max(var(--gutter),env(safe-area-inset-right)) 0 max(var(--gutter),env(safe-area-inset-left))}
.logo{display:inline-flex;align-items:center;gap:.55rem;font:680 1.35rem/1 var(--font-display);font-stretch:90%;letter-spacing:-.01em;text-decoration:none}
.logo img{width:28px;height:28px}
.bar nav{display:flex;gap:clamp(1rem,3vw,1.75rem)}.bar nav a{font-weight:600;font-size:.95rem;padding:.5rem 0;text-decoration-color:transparent}
.bar nav a:hover,.bar nav a[aria-current]{text-decoration-color:var(--jelly)}
main{flex:1;width:100%;max-width:calc(42rem + 2*var(--gutter));margin:0 auto;padding:clamp(1.5rem,5svh,3.5rem) var(--gutter) 4rem}
.wide main{max-width:calc(66rem + 2*var(--gutter))}
h1,h2,h3{font-family:var(--font-display);text-wrap:balance}
h1{font-size:clamp(2.3rem,6vw,3.6rem);font-weight:790;font-stretch:84%;line-height:.94;letter-spacing:-.016em;margin:.25rem 0 .9rem}
h2{font-size:1.5rem;font-weight:680;font-stretch:90%;line-height:1.15;letter-spacing:-.006em;margin:2.25rem 0 .5rem}
h2 a{text-decoration-color:transparent}h2 a:hover{text-decoration-color:var(--jelly)}main h2[id]{scroll-margin-top:1rem}
p,ul,ol,dl,table{margin:0 0 1rem}li+li{margin-top:.3rem}
.lede{font:560 clamp(1.15rem,2.2vw,1.45rem)/1.25 var(--font-display);font-stretch:92%;letter-spacing:-.006em;margin-bottom:1.25rem}
.muted,time{color:var(--muted);font-size:.92rem}.back{margin:0 0 .5rem;font-size:.92rem}.back a{color:var(--muted)}
.notice{border-left:3px solid var(--jelly);background:color-mix(in oklch,var(--jelly) 12%,var(--bg));border-radius:0 .6rem .6rem 0;
padding:.8rem 1rem;font-size:.95rem}
.post{padding:1.25rem 0 .5rem;border-top:1px solid var(--line)}.post h2{margin-top:0}.post p{margin-bottom:.4rem}
.glance{margin:1.5rem 0;padding:1rem 1.25rem .25rem;border-radius:1rem;background:color-mix(in oklch,var(--water-mid) 70%,var(--bg))}
.glance h2{margin-top:0;font-size:1.2rem}
.toc{margin:1.5rem 0;padding-top:1rem;border-top:1px solid var(--line)}.toc ol{columns:2 14rem;column-gap:2rem;padding-left:1.25rem;font-size:.95rem}
table{border-collapse:collapse;width:100%;font-size:.95rem;line-height:1.45;display:block;overflow-x:auto}
th,td{text-align:left;vertical-align:top;padding:.55rem .9rem .55rem 0;border-top:1px solid var(--line)}th{font-weight:600}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:1.25rem;margin:1.5rem 0 2rem}
.plan{border:1px solid var(--line);border-radius:1.25rem;padding:1.4rem 1.4rem .6rem;background:var(--surface)}
.plan[data-status="proposed"]{border-style:dashed;background:transparent}.plan h2{margin-top:.35rem}.plan table{display:table}
.tag{font:600 .7rem/1 var(--font-body);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
.price{font:790 2.4rem/1 var(--font-display);font-stretch:84%;letter-spacing:-.016em;margin:.35rem 0 .75rem}
.faq dt{font:650 1.15rem/1.25 var(--font-display);font-stretch:92%;margin-top:1.25rem}.faq dd{margin:.3rem 0 0}
article.entry p{max-width:38rem}
.foot{padding:2.5rem var(--gutter) calc(2.5rem + env(safe-area-inset-bottom));color:var(--muted);font-size:.9rem;text-align:center;
background:linear-gradient(180deg,var(--bg),var(--water-mid))}
.foot nav{display:flex;flex-wrap:wrap;justify-content:center;gap:.35rem 1.25rem;margin-bottom:1rem}.foot nav a{display:inline-block;padding:.35rem 0}
.foot p{margin:.25rem 0}
@media (max-width:24rem){.logo span{display:none}}
</style></head><body id="top" class="${[wide ? "wide" : "", bodyClass].filter(Boolean).map(esc).join(" ")}"><header class="bar">
<a class="logo" href="/" aria-label="${NAME}, home"><img src="/assets/brand/logo.svg" alt="" width="28" height="28"><span aria-hidden="true">ephyra</span></a>
<nav aria-label="Site">${nav}</nav></header><main>${body}</main>
<footer class="foot"><nav aria-label="Site and legal"><a href="/docs">Docs</a><a href="/blog/">Journal</a>
<a href="/pricing">Pricing</a><a href="/security">Security</a>
<a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable use</a>
<a href="/legal/providers">Service providers</a></nav>
<p>The journal is published with <a href="https://standard.site">Standard.site</a> on AT Protocol. <a href="/blog/feed.xml">RSS</a></p>
<p>“Jellyware” is <a href="https://ampcode.com/podcast/season-02/episode-02" rel="noopener">Amp’s word</a>.</p>
</footer></body></html>`, "text/html");
  }

  async function blog(path: string): Promise<Response> {
    let pub: Publication | null;
    try { pub = await publication(); } catch {
      return text("The journal's source is unavailable right now. Please try again shortly.", "text/plain",
        { "x-robots-tag": "noindex", "cache-control": "no-store", "retry-after": "60" }, 503);
    }
    const name = pub?.publication.value.name ?? `${NAME} journal`;
    const description = pub?.publication.value.description ?? PAGES.find((p) => p.path === "/blog/")!.summary;
    if (path === "/blog/" || path === "/blog") {
      const list = (pub?.posts ?? []).map((p) => `<article class="post"><h2><a href="/blog${esc(p.value.path)}">${esc(p.value.title)}</a></h2>`
        + `<p>${esc(excerpt(p))}</p><time datetime="${esc(p.value.publishedAt)}">${esc(p.value.publishedAt.slice(0, 10))}</time></article>`).join("");
      const empty = pub ? "<p class=\"muted\">No articles yet.</p>"
        : "<p class=\"muted\">The journal is not connected to its publication yet.</p>";
      const schema = { "@context": "https://schema.org", "@type": "Blog", name, description, url: `${origin}/blog/` };
      return page(name, description, "/blog/", `<h1>${esc(name)}</h1><p class="lede">${esc(description)}</p>${list || empty}`,
        `<script type="application/ld+json">${ldJson(schema)}</script>`);
    }
    const slug = path.slice("/blog".length);
    const post = pub?.posts.find((p) => p.value.path === slug);
    if (!post) return notFound();
    const body = post.value.textContent.split(/\n\s*\n/).map((para) => `<p>${esc(para).replaceAll("\n", "<br>")}</p>`).join("");
    const schema = {
      "@context": "https://schema.org", "@type": "BlogPosting", headline: post.value.title, description: excerpt(post),
      datePublished: post.value.publishedAt, url: origin + path, mainEntityOfPage: origin + path,
      isPartOf: { "@type": "Blog", name, url: `${origin}/blog/` }, publisher: { "@type": "Organization", name: NAME, url: origin },
      ...(post.value.tags?.length ? { keywords: post.value.tags.join(", ") } : {}),
    };
    return page(post.value.title, excerpt(post), path,
      `<p class="back"><a href="/blog/">← Journal</a></p><article class="entry"><h1>${esc(post.value.title)}</h1>`
        + `<p><time datetime="${esc(post.value.publishedAt)}">${esc(post.value.publishedAt.slice(0, 10))}</time></p>${body}</article>`,
      `<link rel="site.standard.document" href="${esc(post.uri)}"><meta property="article:published_time" content="${esc(post.value.publishedAt)}">`
      + `<script type="application/ld+json">${ldJson(schema)}</script>`, "article");
  }

  /** Pricing, the legal index and documents, and short aliases (/terms, /privacy) that redirect to them. */
  async function legalRoute(path: string): Promise<Response | null> {
    const aliases: Record<string, string> = {
      "/terms": "/legal/terms", "/privacy": "/legal/privacy", "/acceptable-use": "/legal/acceptable-use",
      "/legal": "/legal/", "/pricing/": "/pricing", "/security/": "/security", "/legal/security": "/security",
    };
    const alias = aliases[path] ?? (path.startsWith("/legal/") && path.endsWith("/") && path !== "/legal/" ? path.slice(0, -1) : undefined);
    if (alias) return Response.redirect(origin + alias, 308);
    if (path === "/pricing") {
      return page(`Pricing · ${NAME}`, PAGES.find((p) => p.path === "/pricing")!.summary, path, pricingBody(), "", "website", true);
    }
    if (path === "/legal/") return page(`Legal · ${NAME}`, "Terms, privacy, acceptable use, service providers and security.", path, legalIndex());
    const doc = LEGAL_DOCS.find((d) => d.path === path);
    return doc ? page(`${doc.title} · ${NAME}`, doc.summary, path, await legalBody(doc, contentDir, operator)) : null;
  }

  async function route(req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const url = new URL(req.url);
    const path = url.pathname;
    if (path !== "/healthz" && redirectHosts.has(url.host)) {
      return Response.redirect(`${origin}${path}${url.search}`, 308);
    }
    if (path === "/auth.md" || path === "/agent/access") {
      const headers = { "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };
      if (apiOrigin) return new Response(null, { status: 307, headers: { ...headers, location: `${apiOrigin.origin}${path}` } });
      return text("Agent setup is unavailable until the operator connects this site to an Ephyra server with EPHYRA_API_ORIGIN.",
        "text/plain", headers, 503);
    }
    if (path === "/app" || path === "/app/") {
      if (apiOrigin) return new Response(null, {
        status: 302, headers: { location: `${apiOrigin.origin}/app/`, "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
      return text("This site is not connected to an Ephyra server yet. The operator needs to set EPHYRA_API_ORIGIN.",
        "text/plain", { "cache-control": "no-store", "x-robots-tag": "noindex" }, 503);
    }
    if (path === "/healthz") return Response.json({ ok: true, blog: Boolean(config.publicationUri) }, { headers: { "x-robots-tag": "noindex" } });
    // The actual app components share their public asset paths with the isolated walkthrough build.
    if (path.startsWith("/app/")) return (await staticFile(`e/app/${path.slice(5)}`)) ?? notFound();
    if (path === "/docs/") return Response.redirect(`${origin}/docs${url.search}`, 308);
    if (path === "/docs") {
      const schema = { "@context": "https://schema.org", "@type": "TechArticle", headline: "Ephyra documentation",
        description: DOCS_DESCRIPTION, dateModified: DOCS_UPDATED, url: `${origin}/docs`, inLanguage: "en",
        publisher: { "@type": "Organization", name: NAME, url: origin } };
      return page(`Documentation · ${NAME}`, DOCS_DESCRIPTION, path, docsBody(),
        `<link rel="stylesheet" href="/docs/styles.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500&display=swap">`
        + `<script type="module" src="/docs/client.js"></script><script type="application/ld+json">${ldJson(schema)}</script>`,
        "website", true, "docs-page");
    }
    if (path === "/docs.txt") return text(docsPlainText(), "text/plain");
    if (path === "/docs/styles.css" || path === "/docs/client.js") {
      return new Response(Bun.file(join(import.meta.dir, "../content", path.slice(1))), { headers: {
        "content-type": path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300", "x-content-type-options": "nosniff",
      } });
    }
    if (path.startsWith("/docs/")) return notFound();
    if (path === "/robots.txt") return text(robots(), "text/plain");
    if (path === "/sitemap.xml") return text(await sitemap(), "application/xml");
    if (path === "/llms.txt") return text(await llms(false), "text/plain");
    if (path === "/llms-full.txt") return text(await llms(true), "text/plain");
    if (path === "/blog/feed.xml" || path === "/feed.xml") return text(await feed(), "application/rss+xml");
    if (path === "/.well-known/site.standard.publication") {
      return config.publicationUri ? text(config.publicationUri, "text/plain") : notFound();
    }
    if (path === "/.well-known/security.txt") return text(securityTxt(origin, operator), "text/plain");
    const legal = await legalRoute(path);
    if (legal) return legal;
    // Standard.site readers join the publication origin and the stored /posts/<slug> path directly.
    if (articlePath(url.pathname)) return Response.redirect(`${origin}/blog${path}${url.search}`, 308);
    if (path === "/blog") return Response.redirect(`${origin}/blog/`, 308);
    if (path.startsWith("/blog/")) {
      const trimmed = path.replace(/\/+$/, "");
      if (path !== "/blog/" && path.endsWith("/") && articlePath(trimmed.slice(5))) return Response.redirect(origin + trimmed, 308);
      if (path === "/blog/" || articlePath(path.slice(5))) return blog(path);
      return notFound();
    }
    // The home cut is served at "/" and nowhere else: its own folder URL redirects home. Its files (styles, script,
    // images) still load from that folder through <base>. Every other cut is reachable at /<cut>/ but not indexed.
    if (path === "/") return (await staticFile(`${home}/`, true)) ?? notFound();
    if (path === `/${home}/` || path === `/${home}/index.html` || path === `/${home}`) return Response.redirect(`${origin}/`, 308);
    if (path === "/index.html") return Response.redirect(`${origin}/`, 308);
    return (await staticFile(path.slice(1))) ?? notFound();
  }

  return async (req: Request): Promise<Response> => {
    const res = await route(req);
    return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };
}
