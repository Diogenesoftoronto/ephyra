// Ephyra's public site: the landing page, the Standard.site blog, and everything crawlers and LLMs read.
// One Bun handler; static files come from site/ (the landing cuts and shared assets).
import { join, normalize } from "node:path";
import { articlePath, publicationIdentity, readPublication, type DocumentRecord, type Fetcher, type Publication } from "./standard.ts";
import { LEGAL_DOCS, OPERATOR, legalBody, legalIndex, securityTxt, type Operator } from "./legal.ts";
import { pricingBody, pricingSummary } from "./pricing.ts";

export type SiteConfig = {
  /** Canonical origin of the public site, e.g. https://ephyra.dev */
  origin: string;
  /** Directory holding index.html, b/, c/, assets/ */
  root: string;
  /** Which landing cut is the home page: "" (cut A), "b" or "c". Others stay reachable at /b/ and /c/. */
  home: "" | "b" | "c";
  /** at://did/site.standard.publication/rkey; the blog shows a setup notice without it. */
  publicationUri?: string;
  /** The control-plane API (linked from llms.txt). */
  apiOrigin?: string;
  fetcher?: Fetcher;
  /** Seconds to cache the publication read. */
  cacheS?: number;
  /** Directory holding the legal page bodies. Defaults to apps/web/content/legal. */
  contentDir?: string;
  /** Operator named in the legal pages. Defaults to OPERATOR in legal.ts. */
  operator?: Operator;
};

const NAME = "Ephyra";
const TAGLINE = "Software that sets itself.";
const SUMMARY = "Ephyra is open-source, self-hostable self-driving software: production errors become trails that go from "
  + "evidence to a failing repro, a patch, proof and a landing on a forge you own, with humans approving at checkpoints. "
  + "No pull requests, no GitHub required. Pre-alpha.";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const xml = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
const ldJson = (v: unknown) => JSON.stringify(v).replaceAll("<", "\\u003c");
const excerpt = (p: DocumentRecord) => p.value.description || p.value.textContent.replace(/\s+/g, " ").slice(0, 180);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon",
};

/** Static pages listed in the sitemap and llms.txt. */
const PAGES = [
  { path: "/", title: `${NAME} · ${TAGLINE}`, summary: SUMMARY },
  { path: "/b/", title: `${NAME} · Lightbox`, summary: "The design as a lightbox: poke the jelly, land a bad patch, watch it roll back." },
  { path: "/c/", title: `${NAME} · Seventy-five words`, summary: "A short, scroll-scrubbed film of one trail, from a production error to a landed fix." },
  { path: "/blog/", title: `${NAME} journal`, summary: "Notes on building self-driving software: trails, proof, jellyware." },
  { path: "/pricing", title: `Pricing · ${NAME}`, summary: "Self-hosting is free; hosted models bill per call; a usage-based hosted plan is proposed." },
  { path: "/legal/", title: `Legal · ${NAME}`, summary: "Terms, privacy, acceptable use, service providers and security." },
  ...LEGAL_DOCS.map((d) => ({ path: d.path, title: `${d.title} · ${NAME}`, summary: d.summary })),
];

export function createSite(config: SiteConfig) {
  const origin = new URL(config.origin).origin;
  const fetcher = config.fetcher ?? fetch;
  const cacheMs = (config.cacheS ?? 60) * 1000;
  const contentDir = config.contentDir ?? join(import.meta.dir, "../content/legal");
  const operator = config.operator ?? OPERATOR;
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
   * Tags a page already has are left alone.
   */
  function seoHead(html: string, canonicalPath: string): string {
    const url = origin + canonicalPath;
    const has = (pattern: RegExp) => pattern.test(html);
    const tags: string[] = [];
    if (!has(/rel="canonical"/)) tags.push(`<link rel="canonical" href="${esc(url)}">`);
    if (!has(/property="og:url"/)) tags.push(`<meta property="og:url" content="${esc(url)}">`);
    if (!has(/property="og:site_name"/)) tags.push(`<meta property="og:site_name" content="${NAME}">`);
    if (!has(/name="twitter:card"/)) tags.push('<meta name="twitter:card" content="summary_large_image">');
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
    return tags.length ? fixed.replace(/<\/head>/i, `${tags.join("")}\n</head>`) : fixed;
  }

  async function staticFile(path: string, canonicalPath?: string): Promise<Response | null> {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.(\/|\\|$))+/, "");
    if (rel.includes("..") || rel.split("/").some((part) => part.startsWith(".") && part !== ".")) return null;
    let file = Bun.file(join(config.root, rel));
    if (rel.endsWith("/") || !(await file.exists())) {
      const index = Bun.file(join(config.root, rel, "index.html"));
      if (!(await index.exists())) return null;
      file = index;
    }
    const ext = /\.[a-z0-9]+$/i.exec(file.name ?? "")?.[0]?.toLowerCase() ?? "";
    if (ext === ".html") {
      const html = seoHead(await file.text(), canonicalPath ?? ("/" + rel).replace(/index\.html$/, ""));
      return new Response(html, { headers: { "content-type": TYPES[".html"]!, "cache-control": "public, max-age=300" } });
    }
    const immutable = rel.startsWith("assets/");
    return new Response(file, { headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=86400" : "public, max-age=300",
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
      "Ephyra watches production through OpenTelemetry, triages each new error with small System One decision models",
      "(Jev, Clairic, or self-hosted d1/Clef), and opens a trail: a durable unit of work stored as git refs",
      "(refs/ephyra/trails/<id>) that moves through research, a failing reproduction, a plan, a patch and proof.",
      "Humans approve at checkpoints A, B and C from a keyboard inbox. Approved fixes land on Radicle, Tangled,",
      "plain git or a Sapling stack, then a watch window rolls them back automatically if the error returns.",
      "Accounts are Not Organic identities; state lives in Convex; agent steps can run in Amp orbs.", "",
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

  function page(title: string, description: string, path: string, body: string, head = "", type = "website", wide = false): Response {
    const url = origin + path;
    return text(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:site_name" content="${NAME}"><meta property="og:type" content="${type}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${origin}/assets/og/og.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${NAME} journal" href="${origin}/blog/feed.xml">${head}
<style>
:root{color-scheme:light dark;--bg:#f6efe1;--fg:#2b2117;--muted:#6b5a48;--accent:#b8661c;--line:#2b211726}
@media (prefers-color-scheme:dark){:root{--bg:#121822;--fg:#f2ead9;--muted:#bba98f;--accent:#f0b35a;--line:#f2ead920}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.6 ui-serif,Georgia,serif}
header,main,footer{max-width:42rem;margin:0 auto;padding:1.25rem max(16px,env(safe-area-inset-left))}
header{display:flex;gap:1rem;align-items:center;font:600 1rem system-ui,sans-serif}
header a{color:inherit;text-decoration:none}header img{width:28px;height:28px}
h1{font:800 clamp(2rem,6vw,3rem)/1.05 system-ui,sans-serif;letter-spacing:-.02em;margin:.5rem 0 1rem}
h2{font:700 1.3rem/1.2 system-ui,sans-serif;margin:0 0 .25rem}h2 a{color:inherit}
.post{padding:1.25rem 0;border-top:1px solid var(--line)}time,.muted{color:var(--muted);font:500 .9rem system-ui,sans-serif}
a{color:var(--accent)}footer{color:var(--muted);font:500 .9rem system-ui,sans-serif;border-top:1px solid var(--line)}
header nav{margin-left:auto;display:flex;gap:1rem;flex-wrap:wrap}footer nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem}
.wide header,.wide main,.wide footer{max-width:64rem}.lede{font-size:1.15rem}
.notice{border:1px solid var(--accent);border-radius:.6rem;padding:.75rem 1rem;font:500 .95rem/1.5 system-ui,sans-serif}
h1+.lede{margin-top:0}main h2{margin-top:2rem}main h2[id]{scroll-margin-top:1rem}.toc ol{columns:2 14rem;font:500 .95rem/1.7 system-ui,sans-serif}
table{border-collapse:collapse;width:100%;font:400 .95rem/1.45 system-ui,sans-serif;display:block;overflow-x:auto}
th,td{text-align:left;vertical-align:top;padding:.5rem .75rem .5rem 0;border-top:1px solid var(--line)}th{font-weight:700}
.glance{border-top:1px solid var(--line);margin-top:1rem}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:1.25rem}
.plan{border:1px solid var(--line);border-radius:.9rem;padding:1.25rem}.plan h2{margin-top:.25rem}.plan table{display:table}
.tag{font:700 .8rem system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:0}
.price{font:800 2rem/1.1 system-ui,sans-serif;margin:.25rem 0}.faq dt{font:700 1rem system-ui,sans-serif;margin-top:1rem}.faq dd{margin:.25rem 0 0}
</style></head><body${wide ? ' class="wide"' : ""}><header>
<a href="/"><img src="/assets/brand/logo.svg" alt="" width="28" height="28"></a><a href="/">${NAME}</a>
<nav aria-label="Site"><a href="/pricing">Pricing</a><a href="/blog/">Journal</a><a href="/security">Security</a></nav></header><main>${body}</main>
<footer><nav aria-label="Legal"><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/legal/acceptable-use">Acceptable use</a>
<a href="/legal/providers">Service providers</a><a href="/security">Security</a><a href="/pricing">Pricing</a></nav>
<p>The journal is published with <a href="https://standard.site">Standard.site</a> on AT Protocol. <a href="/blog/feed.xml">RSS</a></p>
</footer></body></html>`, "text/html");
  }

  async function blog(path: string): Promise<Response> {
    let pub: Publication | null;
    try { pub = await publication(); } catch {
      return text("The journal's source is unavailable right now. Please try again shortly.", "text/plain",
        { "x-robots-tag": "noindex", "cache-control": "no-store", "retry-after": "60" }, 503);
    }
    const name = pub?.publication.value.name ?? `${NAME} journal`;
    const description = pub?.publication.value.description ?? PAGES[3]!.summary;
    if (path === "/blog/" || path === "/blog") {
      const list = (pub?.posts ?? []).map((p) => `<article class="post"><h2><a href="/blog${esc(p.value.path)}">${esc(p.value.title)}</a></h2>`
        + `<p>${esc(excerpt(p))}</p><time datetime="${esc(p.value.publishedAt)}">${esc(p.value.publishedAt.slice(0, 10))}</time></article>`).join("");
      const empty = pub ? "<p class=\"muted\">No articles yet.</p>"
        : "<p class=\"muted\">The journal is not connected to its publication yet.</p>";
      const schema = { "@context": "https://schema.org", "@type": "Blog", name, description, url: `${origin}/blog/` };
      return page(name, description, "/blog/", `<h1>${esc(name)}</h1><p>${esc(description)}</p>${list || empty}`,
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
      `<p><a href="/blog/">← Journal</a></p><h1>${esc(post.value.title)}</h1>`
        + `<time datetime="${esc(post.value.publishedAt)}">${esc(post.value.publishedAt.slice(0, 10))}</time>${body}`,
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
    if (path === "/healthz") return Response.json({ ok: true, blog: Boolean(config.publicationUri) }, { headers: { "x-robots-tag": "noindex" } });
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
    if (path === "/blog") return Response.redirect(`${origin}/blog/`, 308);
    if (path.startsWith("/blog/")) {
      const trimmed = path.replace(/\/+$/, "");
      if (path !== "/blog/" && path.endsWith("/") && articlePath(trimmed.slice(5))) return Response.redirect(origin + trimmed, 308);
      if (path === "/blog/" || articlePath(path.slice(5))) return blog(path);
      return notFound();
    }
    // The home cut is served at "/" with "/" as its canonical URL, so its /b/ or /c/ copy is the duplicate.
    if (path === "/" && config.home) return (await staticFile(`${config.home}/`, "/")) ?? notFound();
    if (path === "/a/" || path === "/a") return (await staticFile("index.html")) ?? notFound();
    return (await staticFile(path.slice(1) || "index.html")) ?? notFound();
  }

  return async (req: Request): Promise<Response> => {
    const res = await route(req);
    return req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  };
}
