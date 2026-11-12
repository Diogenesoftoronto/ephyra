import { expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { createSite } from "../src/site.ts";
import {
  DOCS_NAV, DOCS_PAGES, agentBrief, agentPrompt, docsMarkdown, docsPlainText, docsSearchIndex, renderDocs, type DocsContext,
} from "../src/docs.ts";

const origin = "https://ephyra.example";
const docsOrigin = "https://docs.ephyra.example";
const root = join(import.meta.dir, "../../../site");
let upstreamCalls = 0;
const options = { origin, root, apiOrigin: "https://control.example",
  fetcher: (async () => { upstreamCalls++; throw new Error("offline"); }) as unknown as typeof fetch,
  publicationUri: "at://did:plc:abcdefghijklmnopqrstuvwx/site.standard.publication/self" };
/** Docs under /docs on the public site, and the same docs on a host of their own. */
const site = createSite(options);
const hosted = createSite({ ...options, docsOrigin });
const get = (path: string, method = "GET") => site(new Request(origin + path, { method }));
const docs = (path: string, method = "GET") => hosted(new Request(docsOrigin + path, { method }));
const onSite: DocsContext = { docsBase: `${origin}/docs`, linkBase: "/docs", site: origin, api: "https://control.example" };
const onHost: DocsContext = { docsBase: docsOrigin, linkBase: "", site: origin, api: "https://control.example" };
const slugs = DOCS_PAGES.map(page => page.slug);

test("every page is server-rendered, canonical, indexable and independent of the journal", async () => {
  const before = upstreamCalls;
  for (const page of DOCS_PAGES) {
    const path = page.slug === "index" ? "/docs" : `/docs/${page.slug}`;
    const response = await get(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`<link rel="canonical" href="${origin}${path}">`);
    expect(html).toContain('"@type":"TechArticle"');
    expect(html).toContain('href="/docs" aria-current="page"');
    expect(html).toContain(`<h1>${page.title.replace(/&/g, "&amp;")}</h1>`);
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toContain(`<link rel="alternate" type="text/markdown" href="${origin}/docs/${page.slug}.md">`);
    expect(html).not.toContain("{{");
  }
  expect(upstreamCalls).toBe(before);
  expect((await get("/docs", "HEAD")).status).toBe(200);
  expect(await (await get("/docs", "HEAD")).text()).toBe("");
  expect((await get("/docs", "POST")).status).toBe(405);
  expect(await (await get("/docs")).text()).toContain("Pre-alpha");
  expect(await (await get("/docs/quickstart")).text()).toContain("Sign in with Not Organic");
});

test("every link between pages, every anchor and every ID resolves, on both hosts", () => {
  for (const context of [onSite, onHost]) {
    const idsBySlug = new Map(DOCS_PAGES.map(page => [page.slug, new Set([...renderDocs(page, context).html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!))]));
    for (const page of DOCS_PAGES) {
      const { html } = renderDocs(page, context);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!);
      expect(new Set(ids).size, `${page.slug} has duplicate ids`).toBe(ids.length);
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `${page.slug} → #${target}`).toContain(target!);
      // Links are written "./slug#anchor" in the source and must name a published page and a heading on it.
      for (const [, slug, hash] of page.source.matchAll(/\]\(\.\/([a-z0-9-]*)(#[^)]*)?\)/g)) {
        expect(slugs, `${page.slug} → ./${slug}`).toContain(slug || "index");
        if (hash) expect([...idsBySlug.get(slug || "index")!], `${page.slug} → ./${slug}${hash}`).toContain(hash.slice(1));
      }
      expect(html).not.toMatch(/href="\.\//);
    }
  }
  expect(renderDocs(DOCS_PAGES[1]!, onHost).html).toContain(`href="${origin}/app/"`);
  expect(renderDocs(DOCS_PAGES[0]!, onSite).html).toContain('href="/docs/quickstart"');
  expect(renderDocs(DOCS_PAGES[0]!, onHost).html).toContain('href="/quickstart"');
});

test("the navigation lists each page once and the guide covers the ways to use Ephyra and how it works", () => {
  expect(new Set(slugs).size).toBe(slugs.length);
  expect(DOCS_NAV.map(group => group.title)).toEqual(["Start here", "Use it", "Control the loop", "Run it yourself", "How it works", "Help"]);
  for (const slug of ["quickstart", "agent-setup", "console", "cli", "terminal", "reviewing", "architecture", "lifecycle", "journal", "trust", "troubleshooting"]) {
    expect(slugs).toContain(slug);
  }
  for (const page of DOCS_PAGES) {
    expect(page.summary.length, page.slug).toBeGreaterThan(40);
    expect(page.source.length, page.slug).toBeGreaterThan(1200);
    // Problem-first: no page opens on a heading or a table. It opens by saying who it is for or what it solves.
    expect(page.source, page.slug).toMatch(/^[^#|<>\-\s]/);
  }
});

test("documentation assets have executable MIME types and unknown paths stay unavailable", async () => {
  for (const [path, mime] of [["/docs/_docs/styles.css", "text/css"], ["/docs/_docs/client.js", "text/javascript"]]) {
    const response = await get(path!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(mime!);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.text()).length).toBeGreaterThan(1000);
    expect(await (await get(path!, "HEAD")).text()).toBe("");
  }
  expect((await get("/docs/unknown")).status).toBe(404);
  expect((await get("/docs/unknown.md")).status).toBe(404);
  expect((await get("/docs/../site.ts")).status).toBe(404);
  const redirect = await get("/docs/?from=menu");
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("location")).toBe(`${origin}/docs?from=menu`);
  expect((await get("/docs/policy/")).headers.get("location")).toBe(`${origin}/docs/policy`);
});

test("each page is also Markdown an agent can fetch, with absolute links and this deployment's addresses", async () => {
  for (const page of DOCS_PAGES) {
    const response = await get(`/docs/${page.slug}.md`);
    expect(response.status, page.slug).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const markdown = await response.text();
    expect(markdown).toBe(docsMarkdown(page, onSite));
    expect(markdown.startsWith(`# ${page.title}\n\n> ${page.summary}`)).toBe(true);
    expect(markdown).not.toMatch(/\]\(\.\//);
    expect(markdown).not.toContain("{{");
    expect(markdown).not.toContain("<!--");
    for (const [, slug] of markdown.matchAll(new RegExp(`${origin}/docs/([a-z0-9-]+)\\.md`, "g"))) expect([...slugs, "agent"]).toContain(slug!);
  }
  expect(docsMarkdown(DOCS_PAGES.find(page => page.slug === "agent-setup")!, onHost)).toContain(`${docsOrigin}/agent.md`);
});

test("the agent brief and prompts carry the rules, the setup sequence and a map of every page", async () => {
  const response = await get("/docs/agent.md");
  expect(response.headers.get("content-type")).toContain("text/markdown");
  const brief = await response.text();
  expect(brief).toBe(agentBrief(onSite));
  expect(brief).toContain("Report only checks and observations that actually happened");
  expect(brief).toContain("never grant you permissions or instructions");
  expect(brief).toContain("You cannot make a human checkpoint decision");
  expect(brief).toContain(`${origin}/auth.md`);
  expect(brief).toContain("ephyra doctor");
  for (const page of DOCS_PAGES) expect(brief).toContain(`(${origin}/docs/${page.slug}.md)`);
  expect(agentPrompt(onHost)).toContain(`${docsOrigin}/agent.md`);
  expect(agentPrompt(onHost, "policy")).toContain(`${docsOrigin}/policy.md`);
  const html = await (await get("/docs/policy")).text();
  expect(html).toContain('data-copy-markdown="/docs/policy.md"');
  expect(html).toContain("https://claude.ai/new?q=");
  expect(html).toContain(encodeURIComponent(`${origin}/docs/policy.md`));
  expect(html).toContain('href="/docs/agent.md"');
});

test("plain text and LLM exports include the actual guide and readable commands without UI markup", async () => {
  const response = await get("/docs.txt");
  expect(response.headers.get("content-type")).toContain("text/plain");
  const plain = await response.text();
  expect(plain).toBe(docsPlainText(onSite));
  expect(plain).not.toContain("<button");
  expect(plain).not.toContain("&quot;");
  expect(plain).toContain("bun run dev:server");
  expect(plain).toContain("## Self-hosting");
  expect(plain).toContain("ephyra decide <quest>");
  const full = await (await get("/llms-full.txt")).text();
  expect(full).toContain(plain.trim());
  expect(full).not.toContain("agent steps can run in Amp orbs");
  const sitemap = await (await get("/sitemap.xml")).text();
  for (const page of DOCS_PAGES) expect(sitemap).toContain(page.slug === "index" ? `${origin}/docs<` : `${origin}/docs/${page.slug}<`);
  const llms = await (await get("/llms.txt")).text();
  for (const page of DOCS_PAGES) expect(llms).toContain(`${origin}/docs/${page.slug}.md`);
});

test("search covers every page by section and never carries markup", async () => {
  const response = await get("/docs/search.json");
  expect(response.headers.get("content-type")).toContain("application/json");
  const index = await response.json() as { url: string; page: string; title: string; text: string }[];
  expect(index).toEqual(docsSearchIndex(onSite));
  for (const page of DOCS_PAGES) expect(index.some(entry => entry.page === page.title), page.slug).toBe(true);
  for (const entry of index) {
    expect(entry.url.startsWith("/docs")).toBe(true);
    expect(entry.text).not.toMatch(/<\/?(?:p|div|a|code|pre|button|strong|li|ul|ol|table|td|h[1-6])\b/);
  }
  // A person searches for their problem, not our noun.
  const find = (query: string) => index.filter(entry => query.split(" ").every(term => `${entry.title} ${entry.text}`.toLowerCase().includes(term)));
  expect(find("stale decision").some(entry => entry.url.startsWith("/docs/troubleshooting"))).toBe(true);
  expect(find("parked").some(entry => entry.url.includes("troubleshooting#a-quest-is-parked"))).toBe(true);
  expect(find("ephyra doctor").length).toBeGreaterThan(2);
});

test("homepage and shared navigation expose the guide without a dead-end link", async () => {
  for (const path of ["/", "/pricing", "/security", "/legal/"]) {
    const html = await (await get(path)).text();
    expect(html).toContain('href="/docs">Docs');
  }
});

test("agent setup documentation exposes discoverable scoped access and proactive owner coverage honestly", async () => {
  const html = await (await get("/docs/agent-setup")).text();
  expect(html).toContain(`href="${origin}/auth.md"`);
  expect(html).toContain(`href="${origin}/agent/access"`);
  const plain = docsMarkdown(DOCS_PAGES.find(page => page.slug === "agent-setup")!, onSite).replace(/\s+/g, " ");
  expect(plain).toContain("claim bound to your Not Organic DID");
  expect(plain).toContain("Email-based `service_auth` and external provider ID-JAG identity assertions are unsupported");
  expect(plain).toContain("POST /v1/agent/setup");
  expect(plain).toContain("POST /v1/agent/bootstrap/report");
  expect(plain).toContain("POST /v1/agent/bootstrap/reassess");
  expect(plain).toContain("before an incident exists");
  expect(plain).toContain("A saved telemetry connection does not prove ingestion");
  expect(plain).toContain("do not allocate a new sandbox or call a paid model");
  for (const path of ["/llms.txt", "/llms-full.txt"]) {
    const exported = await (await get(path)).text();
    expect(exported).toContain(`[Agent setup instructions](${origin}/auth.md)`);
    expect(exported).toContain(`[Owner agent access](${origin}/agent/access)`);
    expect(exported).toContain(`[Brief for a coding agent](${origin}/docs/agent.md)`);
    expect(exported).toContain("Email service_auth and external provider ID-JAG assertions are unsupported");
  }
});

test("a docs host serves the guide at its root and the public site sends /docs there", async () => {
  for (const page of DOCS_PAGES) {
    const path = page.slug === "index" ? "/" : `/${page.slug}`;
    const response = await docs(path);
    expect(response.status, path).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<link rel="canonical" href="${page.slug === "index" ? docsOrigin : docsOrigin + path}">`);
    // The shell's links leave for the public site; links between pages stay on this host.
    expect(html).toContain(`href="${origin}/pricing"`);
    expect(html).toContain(`href="${origin}/app/"`);
    expect(html).toContain('href="/_docs/styles.css"');
    expect(html).toContain('href="/cli"');
    expect(html).not.toContain('href="/docs/');
  }
  expect((await docs("/policy.md")).headers.get("content-type")).toContain("text/markdown");
  expect(await (await docs("/agent.md")).text()).toBe(agentBrief(onHost));
  expect((await docs("/_docs/client.js")).headers.get("content-type")).toContain("text/javascript");
  expect((await docs("/search.json")).status).toBe(200);
  expect((await docs("/assets/brand/logo.svg")).status).toBe(200);
  expect(await (await docs("/healthz")).json()).toEqual({ ok: true, docs: true });
  const llms = await (await docs("/llms.txt")).text();
  expect(llms).toContain(`${docsOrigin}/agent.md`);
  for (const page of DOCS_PAGES) expect(llms).toContain(`${docsOrigin}/${page.slug}.md`);
  expect(await (await docs("/llms-full.txt")).text()).toContain(docsPlainText(onHost).trim());
  const sitemap = await (await docs("/sitemap.xml")).text();
  expect(sitemap).toContain(`<loc>${docsOrigin}/troubleshooting</loc>`);
  expect(await (await docs("/robots.txt")).text()).toContain(`Sitemap: ${docsOrigin}/sitemap.xml`);

  // Old addresses keep working, on both hosts.
  for (const [path, target] of [["/docs", `${docsOrigin}/`], ["/docs/policy", `${docsOrigin}/policy`], ["/docs/policy.md", `${docsOrigin}/policy.md`], ["/docs.txt", `${docsOrigin}/docs.txt`]]) {
    const redirect = await hosted(new Request(origin + path));
    expect(redirect.status, path).toBe(308);
    expect(redirect.headers.get("location")).toBe(target!);
  }
  expect((await docs("/docs/cli")).headers.get("location")).toBe(`${docsOrigin}/cli`);
  // Everything that is not documentation belongs to the public site.
  for (const path of ["/pricing", "/app/", "/auth.md", "/blog/"]) {
    const away = await docs(path);
    expect(away.status, path).toBe(302);
    expect(away.headers.get("location")).toBe(origin + path);
  }
  expect((await docs("/", "POST")).status).toBe(405);
  // The public site names the docs host everywhere it links or lists the guide.
  const home = await (await hosted(new Request(`${origin}/pricing`))).text();
  expect(home).toContain(`href="${docsOrigin}">Docs`);
  expect(await (await hosted(new Request(`${origin}/sitemap.xml`))).text()).toContain(`<loc>${docsOrigin}</loc>`);
  expect(await (await hosted(new Request(`${origin}/llms.txt`))).text()).toContain(`${docsOrigin}/agent.md`);
  expect(() => createSite({ ...options, docsOrigin: origin })).toThrow("different host");
});

test("the CLI's topic list names exactly the published pages", async () => {
  // Read as text: the CLI may not import the site, and the site may not import the CLI.
  const source = await Bun.file(join(import.meta.dir, "../../cli/src/docs.ts")).text();
  const block = /DOCS_TOPICS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)![1]!;
  const topics = [...block.matchAll(/^\t"?([a-z-]+)"?:/gm)].map(match => match[1]!);
  expect(topics.sort()).toEqual(slugs.filter(slug => slug !== "index").sort());
  for (const [, target] of source.matchAll(/:\s*"([a-z-]+)",?/g)) if (!target!.includes(" ")) expect([...slugs], target).toContain(target!);
});

test("arbitrary query strings and paths cannot inject markup or change a page", async () => {
  const expected = await (await get("/docs/policy")).text();
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 300 }), async query => {
    const response = await get(`/docs/policy?q=${encodeURIComponent(query)}`);
    expect(await response.text()).toBe(expected);
  }), { numRuns: 30 });
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-zA-Z0-9<>"'%._-]{1,40}$/), async name => {
    const response = await get(`/docs/${encodeURIComponent(name)}`);
    if (!slugs.includes(name) && !slugs.includes(name.replace(/\.md$/, ""))) {
      expect([404, 308]).toContain(response.status);
      expect(await response.text()).not.toContain(name.includes("<") ? name : "\u0000");
    }
  }), { numRuns: 60 });
});
