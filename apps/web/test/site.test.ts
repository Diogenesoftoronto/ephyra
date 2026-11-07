import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSite } from "../src/site.ts";
import { buildRecords, writeRecords } from "../src/publish.ts";
import { articlePath, publicationIdentity, publicOrigin } from "../src/standard.ts";

const ROOT = join(import.meta.dir, "../../../site");
const ORIGIN = "https://ephyra.example";
const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const URI = `at://${DID}/site.standard.publication/self`;
const PDS = "https://pds.example";

const doc = (rkey: string, path: string, publishedAt: string, extra: Record<string, unknown> = {}) => ({
  uri: `at://${DID}/site.standard.document/${rkey}`, cid: "c",
  value: { $type: "site.standard.document", site: URI, path, title: `Title ${rkey}`, textContent: `Body of ${rkey}.\n\nSecond para.`, publishedAt, ...extra },
});

/** A fake plc.directory + PDS serving one publication. */
function fakeAtproto(docs: unknown[], pubUrl = ORIGIN) {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    calls.push(input);
    const u = new URL(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (u.hostname === "plc.directory") return json({ id: DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] });
    if (u.pathname === "/xrpc/com.atproto.repo.getRecord") {
      return json({ uri: URI, value: { $type: "site.standard.publication", url: pubUrl, name: "Ephyra journal", description: "Notes." } });
    }
    if (u.pathname === "/xrpc/com.atproto.repo.listRecords") return json({ records: docs });
    return json({}, 404);
  };
  return { fetcher, calls };
}

const site = (docs: unknown[] = [], opts: { publicationUri?: string; pubUrl?: string; home?: "" | "b" | "c" } = {}) =>
  createSite({
    origin: ORIGIN, root: ROOT, home: opts.home ?? "", cacheS: 0,
    ...("publicationUri" in opts ? (opts.publicationUri ? { publicationUri: opts.publicationUri } : {}) : { publicationUri: URI }),
    fetcher: fakeAtproto(docs, opts.pubUrl).fetcher,
  });
const get = (h: ReturnType<typeof site>, path: string) => h(new Request(ORIGIN + path));

describe("SEO files", () => {
  test("robots.txt allows crawling and points at the sitemap and llms.txt", async () => {
    const body = await (await get(site(), "/robots.txt")).text();
    expect(body).toContain("User-agent: *\nAllow: /");
    expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(body).toContain(`${ORIGIN}/llms.txt`);
  });

  test("sitemap lists pages and published posts only (not future-dated or invalid records)", async () => {
    const h = site([
      doc("one", "/posts/one", "2026-11-01T00:00:00Z"),
      doc("future", "/posts/future", "2099-01-01T00:00:00Z"),
      doc("bad", "/admin", "2026-11-01T00:00:00Z"),
      { ...doc("other", "/posts/other", "2026-11-01T00:00:00Z"), value: { ...doc("o", "/posts/other", "2026-11-01T00:00:00Z").value, site: "at://elsewhere" } },
    ]);
    const res = await get(h, "/sitemap.xml");
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(body).toContain(`<loc>${ORIGIN}/blog/posts/one</loc>`);
    expect(body).not.toContain("future");
    expect(body).not.toContain("admin");
    expect(body).not.toContain("/posts/other");
  });

  test("llms.txt follows the format (H1, summary blockquote, link lists); llms-full adds article text", async () => {
    const h = site([doc("one", "/posts/one", "2026-11-01T00:00:00Z", { description: "A summary." })]);
    const llms = await (await get(h, "/llms.txt")).text();
    expect(llms.startsWith("# Ephyra\n\n> ")).toBe(true);
    expect(llms).toContain(`- [Title one](${ORIGIN}/blog/posts/one): A summary.`);
    expect(llms).toContain("## Optional");
    const full = await (await get(h, "/llms-full.txt")).text();
    expect(full).toContain("### Title one");
    expect(full).toContain("Second para.");
  });

  test("SEO files still serve when the PDS is down or the blog is not configured", async () => {
    const down = createSite({ origin: ORIGIN, root: ROOT, home: "", publicationUri: URI, cacheS: 0, fetcher: async () => new Response("", { status: 502 }) });
    expect((await get(down, "/sitemap.xml")).status).toBe(200);
    expect((await get(down, "/llms.txt")).status).toBe(200);
    expect((await get(down, "/blog/")).status).toBe(503);
    const none = site([], { publicationUri: undefined });
    expect((await get(none, "/.well-known/site.standard.publication")).status).toBe(404);
    expect(await (await get(none, "/blog/")).text()).toContain("not connected");
  });
});

describe("Standard.site blog", () => {
  test("index lists posts newest first; article has canonical, OG, JSON-LD and the document backlink", async () => {
    const h = site([doc("old", "/posts/old", "2026-10-01T00:00:00Z"), doc("new", "/posts/new", "2026-11-01T00:00:00Z", { tags: ["trails"] })]);
    const index = await (await get(h, "/blog/")).text();
    expect(index.indexOf("Title new")).toBeLessThan(index.indexOf("Title old"));
    const res = await get(h, "/blog/posts/new");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/blog/posts/new">`);
    expect(html).toContain(`<link rel="site.standard.document" href="at://${DID}/site.standard.document/new">`);
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain('"keywords":"trails"');
    expect(html).toContain('property="og:type" content="article"');
  });

  test("feed, publication discovery, redirects and 404s", async () => {
    const h = site([doc("one", "/posts/one", "2026-11-01T00:00:00Z")]);
    const feed = await (await get(h, "/blog/feed.xml")).text();
    expect(feed).toContain(`<link>${ORIGIN}/blog/posts/one</link>`);
    expect(feed).toContain(`<guid isPermaLink="false">at://${DID}/site.standard.document/one</guid>`);
    expect(await (await get(h, "/.well-known/site.standard.publication")).text()).toBe(URI);
    expect((await get(h, "/blog")).status).toBe(308);
    expect((await get(h, "/blog/posts/one/")).headers.get("location")).toBe(`${ORIGIN}/blog/posts/one`);
    expect((await get(h, "/blog/posts/missing")).status).toBe(404);
    expect((await get(h, "/blog/../secret")).status).toBe(404);
  });

  test("record text is escaped; a publication pointing at another domain is rejected", async () => {
    const h = site([doc("x", "/posts/x", "2026-11-01T00:00:00Z", { title: "<script>alert(1)</script>" })]);
    expect(await (await get(h, "/blog/posts/x")).text()).not.toContain("<script>alert(1)");
    const wrong = site([doc("x", "/posts/x", "2026-11-01T00:00:00Z")], { pubUrl: "https://attacker.example" });
    expect((await get(wrong, "/blog/posts/x")).status).toBe(503);
  });
});

describe("static site", () => {
  test("home serves the chosen cut; other cuts and assets stay reachable; dotfiles and traversal are refused", async () => {
    const a = await (await get(site(), "/")).text();
    expect(a).toContain("<title>Ephyra · Software that sets itself</title>");
    const c = await (await get(site([], { home: "c" }), "/")).text();
    expect(c).toContain('class=');
    expect((await get(site(), "/b/")).status).toBe(200);
    expect((await get(site(), "/assets/brand/logo.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await get(site(), "/.git/config")).status).toBe(404);
    expect((await get(site(), "/%2e%2e/package.json")).status).toBe(404);
  });
});

describe("landing SEO head", () => {
  test("served pages get canonical, absolute og:image, Twitter card, RSS link and JSON-LD", async () => {
    const html = await (await get(site(), "/")).text();
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/assets/og/og.png">`);
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('"@type":"SoftwareApplication"');
    expect(html).toContain(`href="${ORIGIN}/blog/feed.xml"`);
    const c = await (await get(site(), "/c/")).text();
    expect(c).toContain(`<link rel="canonical" href="${ORIGIN}/c/">`);
    expect(c).toContain(`content="${ORIGIN}/assets/og/og.png"`); // ../assets/… made absolute
    const home = await (await get(site([], { home: "c" }), "/")).text();
    expect(home).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
    expect(home.match(/rel="canonical"/g)).toHaveLength(1);
  });
});

describe("publisher", () => {
  test("builds publication + document records and rejects bad articles", () => {
    const records = buildRecords(URI, ORIGIN, [{ rkey: "a", path: "/posts/a", title: "A", textContent: "x", publishedAt: "2026-11-07T00:00:00Z", tags: ["t"] }],
      { name: "Ephyra journal", description: "d" });
    expect(records[0]).toMatchObject({ collection: "site.standard.publication", rkey: "self", value: { url: ORIGIN } });
    expect(records[1]!.value).toMatchObject({ site: URI, path: "/posts/a", tags: ["t"] });
    expect(() => buildRecords(URI, ORIGIN, [{ rkey: "a", path: "/admin", title: "A", textContent: "x", publishedAt: "2026-11-07" }],
      { name: "n", description: "d" })).toThrow("path");
    expect(() => buildRecords(URI, "http://ephyra.example", [], { name: "n", description: "d" })).toThrow();
  });

  test("writes with swapRecord and verifies read-back; refuses another account's password", async () => {
    const store = new Map<string, { uri: string; cid: string }>();
    let n = 0;
    const fetcher = async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (u.pathname.endsWith("createSession")) return json({ did: JSON.parse(String(init!.body)).identifier === DID ? DID : "did:plc:other", accessJwt: "t" });
      if (u.pathname.endsWith("getRecord")) {
        const k = `${u.searchParams.get("collection")}/${u.searchParams.get("rkey")}`;
        return store.has(k) ? json(store.get(k)) : json({ error: "RecordNotFound" }, 400);
      }
      if (u.pathname.endsWith("putRecord")) {
        const b = JSON.parse(String(init!.body));
        const k = `${b.collection}/${b.rkey}`;
        if ((store.get(k)?.cid ?? null) !== b.swapRecord) return json({ error: "InvalidSwap" }, 400);
        const saved = { uri: `at://${DID}/${k}`, cid: `cid${++n}` };
        store.set(k, saved);
        return json(saved);
      }
      return json({}, 404);
    };
    const records = buildRecords(URI, ORIGIN, [{ rkey: "a", path: "/posts/a", title: "A", textContent: "x", publishedAt: "2026-11-07T00:00:00Z" }],
      { name: "n", description: "d" });
    expect(await writeRecords(PDS, DID, "pw", records, fetcher)).toHaveLength(2);
    expect(await writeRecords(PDS, DID, "pw", records, fetcher)).toHaveLength(2); // rewrite swaps on the existing cid
    await expect(writeRecords(PDS, "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz", "pw", records, fetcher)).rejects.toThrow("different account");
  });

  test("identity and path guards", () => {
    expect(() => publicationIdentity("at://PLACEHOLDER/site.standard.publication/self")).toThrow();
    expect(() => publicOrigin("https://u:p@x.example")).toThrow();
    for (const p of ["//evil", "/posts/../x", "/posts/%2e%2e", "/posts/A"]) expect(articlePath(p)).toBe(false);
  });
});
