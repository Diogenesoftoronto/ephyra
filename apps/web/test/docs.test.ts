import { expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { createSite } from "../src/site.ts";
import { DOCS_SECTIONS, docsPlainText } from "../src/docs.ts";

const origin = "https://ephyra.example";
let upstreamCalls = 0;
const site = createSite({ origin, root: join(import.meta.dir, "../../../site"),
  apiOrigin: "https://control.example", fetcher: async () => { upstreamCalls++; throw new Error("offline"); },
  publicationUri: "at://did:plc:abcdefghijklmnopqrstuvwx/site.standard.publication/self" });
const get = (path: string, method = "GET") => site(new Request(origin + path, { method }));

test("public guide is server-rendered, canonical, indexable and independent of the journal", async () => {
  const before = upstreamCalls;
  const response = await get("/docs");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain(`<link rel="canonical" href="${origin}/docs">`);
  expect(html).toContain('"@type":"TechArticle"');
  expect(html).toContain('href="/docs" aria-current="page"');
  expect(html).toContain("Pre-alpha");
  expect(html).toContain("Sign in with Not Organic");
  expect(html.replace(/\s+/g, " ")).toContain("Personal workspaces stop when a required cost is unknown.");
  expect(upstreamCalls).toBe(before);
  expect((await get("/docs", "HEAD")).status).toBe(200);
  expect(await (await get("/docs", "HEAD")).text()).toBe("");
  expect((await get("/docs", "POST")).status).toBe(405);
});

test("all table-of-contents, cross-reference and code-copy targets exist with unique IDs", async () => {
  const html = await (await get("/docs")).text();
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!);
  expect(new Set(ids).size).toBe(ids.length);
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) expect(ids).toContain(target!);
  for (const section of DOCS_SECTIONS) expect(html).toContain(`id="${section.id}"`);
  expect(html.match(/class="docs-copy"/g)?.length).toBeGreaterThanOrEqual(6);
  expect(html).toContain('aria-label="Guide navigation"');
  expect(html).toContain('id="docs-announcement" role="status" aria-live="polite"');
});

test("documentation assets have executable MIME types and unknown paths stay unavailable", async () => {
  for (const [path, mime] of [["/docs/styles.css", "text/css"], ["/docs/client.js", "text/javascript"]]) {
    const response = await get(path!);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(mime!);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.text()).length).toBeGreaterThan(1000);
    expect(await (await get(path!, "HEAD")).text()).toBe("");
  }
  expect((await get("/docs/unknown")).status).toBe(404);
  const redirect = await get("/docs/?from=menu");
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("location")).toBe(`${origin}/docs?from=menu`);
});

test("plain text and LLM export include the actual guide and readable commands without UI markup", async () => {
  const response = await get("/docs.txt");
  expect(response.headers.get("content-type")).toContain("text/plain");
  const plain = await response.text();
  expect(plain).toBe(docsPlainText());
  expect(plain).not.toContain("<button");
  expect(plain).not.toContain("&quot;");
  expect(plain).toContain('export EPHYRA_API_TOKEN="$(bun -e');
  expect(plain).toContain("## Self-hosting");
  const full = await (await get("/llms-full.txt")).text();
  expect(full).toContain(plain.trim());
  expect(full).not.toContain("agent steps can run in Amp orbs");
  for (const path of ["/sitemap.xml", "/llms.txt"]) expect(await (await get(path)).text()).toContain(origin + "/docs");
});

test("homepage and shared navigation expose the guide without a dead-end link", async () => {
  for (const path of ["/", "/pricing", "/security", "/legal/"]) {
    const html = await (await get(path)).text();
    expect(html).toContain('href="/docs">Docs');
  }
});

test("agent setup documentation exposes discoverable scoped access and proactive owner coverage honestly", async () => {
  const html = await (await get("/docs")).text();
  expect(html).toContain('href="#agent-setup" data-doc-link="agent-setup"');
  expect(html).toContain('href="/auth.md"');
  expect(html).toContain('href="/agent/access"');
  const plain = docsPlainText().replace(/\s+/g, " ");
  expect(plain).toContain("## Set up with an agent");
  expect(plain).toContain("claim bound to your Not Organic DID");
  expect(plain).toContain("Email-based service_auth and external provider ID-JAG identity assertions are unsupported");
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
    expect(exported).toContain("Email service_auth and external provider ID-JAG assertions are unsupported");
  }
});

test("arbitrary search queries cannot inject markup or change the canonical guide", async () => {
  const expected = await (await get("/docs")).text();
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 300 }), async query => {
    const response = await get(`/docs?q=${encodeURIComponent(query)}`);
    expect(await response.text()).toBe(expected);
  }), { numRuns: 30 });
});
