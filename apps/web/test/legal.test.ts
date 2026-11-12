import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { LEGAL_DOCS, OPERATOR, REVISED, fill } from "../src/legal.ts";
import { money, pricing } from "../src/pricing.ts";
import { createSite } from "../src/site.ts";

const ROOT = join(import.meta.dir, "../../../site");
const ORIGIN = "https://ephyra.example";
const h = createSite({
  origin: ORIGIN, root: ROOT, apiOrigin: "https://control.example", cacheS: 0, fetcher: async () => new Response("", { status: 502 }),
});
const get = (path: string) => h(new Request(ORIGIN + path, { redirect: "manual" }));

const PAGES = [...LEGAL_DOCS.map((d) => d.path), "/legal/", "/pricing"];

describe("legal pages", () => {
  test.each(PAGES)("%s renders with a canonical URL, the review notice and no unfilled placeholders", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${path}">`);
    expect(html).not.toContain("{{");
    expect(html).toContain('href="/legal/privacy"');
    if (path !== "/pricing") expect(html).toContain("Prepared for review, not yet effective.");
  });

  test("documents name the operator and contact, and carry the revision date", async () => {
    for (const doc of LEGAL_DOCS) {
      const html = await (await get(doc.path)).text();
      expect(html).toContain(OPERATOR.name);
      expect(html).toContain(`mailto:${OPERATOR.email}`);
      expect(html).toContain(`<time datetime="${REVISED}">`);
    }
  });

  test("long documents get a table of contents whose anchors exist", async () => {
    const html = await (await get("/legal/terms")).text();
    const toc = [...html.matchAll(/<li><a href="#([a-z0-9-]+)">/g)].map((m) => m[1]);
    expect(toc.length).toBeGreaterThan(5);
    for (const id of toc) expect(html).toContain(`id="${id}"`);
  });

  test("unknown placeholders are an error, never published", () => {
    expect(() => fill("Hello {{nobody}}")).toThrow("Unknown legal placeholder");
    expect(fill("{{operatorName}} <{{contact}}>")).toBe(`${OPERATOR.name} <<a href="mailto:${OPERATOR.email}">${OPERATOR.email}</a>>`);
  });

  test("short and trailing-slash forms redirect to the canonical path", async () => {
    for (const [from, to] of [["/terms", "/legal/terms"], ["/privacy", "/legal/privacy"], ["/legal/terms/", "/legal/terms"],
      ["/legal", "/legal/"], ["/pricing/", "/pricing"], ["/legal/security", "/security"]] as const) {
      const res = await get(from);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(ORIGIN + to);
    }
    expect((await get("/legal/nothing")).status).toBe(404);
  });

  test("security.txt follows RFC 9116 and expires after the revision date", async () => {
    const body = await (await get("/.well-known/security.txt")).text();
    expect(body).toContain(`Contact: mailto:${OPERATOR.securityEmail ?? OPERATOR.email}`);
    expect(body).toContain(`Canonical: ${ORIGIN}/.well-known/security.txt`);
    expect(body).toContain(`Policy: ${ORIGIN}/security`);
    const expires = Date.parse(/^Expires: (.+)$/m.exec(body)![1]!);
    expect(expires).toBeGreaterThan(Date.parse(REVISED));
  });

  test("sitemap and llms.txt list pricing and every legal page", async () => {
    const sitemap = await (await get("/sitemap.xml")).text();
    const llms = await (await get("/llms.txt")).text();
    for (const path of PAGES) {
      expect(sitemap).toContain(`<loc>${ORIGIN}${path}</loc>`);
      expect(llms).toContain(`](${ORIGIN}${path})`);
    }
    expect(llms).toContain("## Pricing");
    expect(llms).toContain("Hosted plan (proposed, not for sale)");
  });

  test("every internal link on the legal pages, pricing and landing cuts resolves (with its #anchor)", async () => {
    const sources = [...PAGES, "/", "/a/", "/b/", "/c/"];
    // The journal is not connected here, so article links are checked against the content the publisher writes.
    const articles = new Set((await Bun.file(join(import.meta.dir, "../content/articles.json")).json() as { path: string }[]).map((a) => `/blog${a.path}`));
    const checked = new Set<string>();
    for (const source of sources) {
      const html = (await (await get(source)).text()).replace(/<base [^>]*>/, "");
      for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
        if (!href || checked.has(href) || href.startsWith("//")) continue;
        checked.add(href);
        const [path, anchor] = href.split("#");
        if (articles.has(path!)) continue;
        const res = await get(path!);
        if (path === "/app/") {
          expect(res.status).toBe(302);
          expect(res.headers.get("location")).toBe("https://control.example/app/");
          continue;
        }
        expect({ href, status: res.status }).toEqual({ href, status: 200 });
        if (anchor) expect(await res.text()).toContain(`id="${anchor}"`);
      }
    }
    expect(checked.size).toBeGreaterThan(10);
  });
});

describe("pricing", () => {
  test("the proposed hosted rates stay unknown rather than looking free or available for sale", async () => {
    const html = await (await get("/pricing")).text();
    for (const rate of pricing.plans[1].rates ?? []) {
      expect(rate.usd).toBeNull();
      expect(html).toContain(`data-rate="${rate.label}" data-usd="unannounced"`);
    }
    expect(html).toContain('data-plan="hosted" data-status="proposed"');
    expect(html).toContain("Proposed · not for sale");
    expect(html).toContain("Hosted credit billing is not implemented");
    expect(pricing.billingImplemented).toBe(false);
  });

  test("public pricing and machine-readable summary distinguish prepaid funds from a grant", async () => {
    for (const path of ["/pricing", "/llms.txt"]) {
      const body = await (await get(path)).text();
      expect(body).toContain("$150");
      expect(body).toContain("customer-funded");
      expect(body).not.toMatch(/Clairic|Jev|System One|Provider cost \+ 5%|\$1\.50|\$20 of usage/);
    }
  });

  test("money keeps every significant decimal and at least two", () => {
    expect([0, 0.1, 0.0609, 1.5, 20, 0.02].map(money)).toEqual(["$0", "$0.10", "$0.0609", "$1.50", "$20", "$0.02"]);
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), (tenThousandths) => {
      const usd = tenThousandths / 1e4;
      expect(Number(money(usd).slice(1))).toBeCloseTo(usd, 10);
    }));
  });
});
