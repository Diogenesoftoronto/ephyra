// Publish Ephyra's journal to AT Protocol as Standard.site records (same contract as voxq/blog/publish.ts).
// Default is a dry run that prints the records. `--write` writes with compare-and-swap and reads each record back.
//   EPHYRA_BLOG_PUBLICATION_URI=at://did:plc:…/site.standard.publication/self
//   EPHYRA_BLOG_ORIGIN=https://<public site origin>
//   EPHYRA_BLOG_APP_PASSWORD=<PDS app password>   (only for --write; inject from a secret store)
import { DOCUMENT, PUBLICATION, articlePath, publicOrigin, publicationIdentity } from "./standard.ts";

export type Article = {
  rkey: string; path: string; title: string; description?: string; textContent: string; publishedAt: string; tags?: string[];
};
type RecordToWrite = { collection: string; rkey: string; value: Record<string, unknown> };

const bounded = (value: unknown, bytes: number, graphemes: number) =>
  typeof value === "string" && new TextEncoder().encode(value).length <= bytes &&
  [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].length <= graphemes;

/** Validate articles and build the publication + document records. Throws on the first invalid article. */
export function buildRecords(uri: string, origin: string, articles: unknown, meta: { name: string; description: string }): RecordToWrite[] {
  const { rkey } = publicationIdentity(uri);
  const canonical = publicOrigin(origin);
  if (!Array.isArray(articles)) throw new Error("Expected an array of articles.");
  const records: RecordToWrite[] = [{
    collection: PUBLICATION, rkey,
    value: { $type: PUBLICATION, url: canonical, name: meta.name, description: meta.description },
  }];
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const [i, a] of (articles as Article[]).entries()) {
    const problem =
      typeof a.rkey !== "string" || !/^[a-z0-9-]{1,512}$/.test(a.rkey) ? "rkey" :
      !articlePath(a.path) ? "path (must be /posts/<slug>)" :
      keys.has(a.rkey) || paths.has(a.path) ? "duplicate rkey or path" :
      !bounded(a.title, 5000, 500) || !a.title.trim() ? "title" :
      a.description !== undefined && !bounded(a.description, 30000, 3000) ? "description" :
      typeof a.textContent !== "string" || !a.textContent.trim() ? "textContent" :
      !Number.isFinite(Date.parse(a.publishedAt)) ? "publishedAt" :
      a.tags !== undefined && (!Array.isArray(a.tags) || a.tags.some((t) => typeof t !== "string" || !bounded(t, 1280, 128))) ? "tags" :
      null;
    if (problem) throw new Error(`Article ${i} has an invalid ${problem}.`);
    keys.add(a.rkey);
    paths.add(a.path);
    records.push({
      collection: DOCUMENT, rkey: a.rkey,
      value: {
        $type: DOCUMENT, site: uri, path: a.path, title: a.title, description: a.description ?? "",
        publishedAt: new Date(a.publishedAt).toISOString(), textContent: a.textContent,
        ...(a.tags?.length ? { tags: a.tags } : {}),
      },
    });
  }
  return records;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Write records with swapRecord and verify each by reading it back. Returns the written URIs. */
export async function writeRecords(pds: string, did: string, password: string, records: RecordToWrite[], fetcher: Fetch = fetch): Promise<string[]> {
  const xrpc = async (method: string, body: unknown, token?: string) => {
    const res = await fetcher(`${pds}/xrpc/${method}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} failed with HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const session = await xrpc("com.atproto.server.createSession", { identifier: did, password });
  if (session.did !== did) throw new Error("The app password belongs to a different account.");
  const written: string[] = [];
  for (const record of records) {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
    url.search = new URLSearchParams({ repo: did, collection: record.collection, rkey: record.rkey }).toString();
    const previous = await fetcher(url.href, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    let cid: string | null = null;
    if (previous.ok) cid = ((await previous.json()) as { cid: string }).cid;
    else if (((await previous.json().catch(() => ({}))) as { error?: string }).error !== "RecordNotFound") {
      throw new Error("Cannot determine the existing record state.");
    }
    const saved = await xrpc("com.atproto.repo.putRecord",
      { repo: did, collection: record.collection, rkey: record.rkey, record: record.value, swapRecord: cid }, session.accessJwt);
    const check = await fetcher(url.href, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const read = check.ok ? ((await check.json()) as { uri: string; cid: string }) : null;
    if (!read || read.uri !== saved.uri || read.cid !== saved.cid) throw new Error(`Read-back failed for ${record.collection}/${record.rkey}.`);
    written.push(saved.uri);
  }
  return written;
}

if (import.meta.main) {
  const uri = process.env.EPHYRA_BLOG_PUBLICATION_URI;
  const origin = process.env.EPHYRA_BLOG_ORIGIN;
  if (!uri || !origin) throw new Error("Set EPHYRA_BLOG_PUBLICATION_URI and EPHYRA_BLOG_ORIGIN.");
  const input = process.argv.find((a) => a.startsWith("--input="))?.slice(8);
  if (!input) throw new Error("Usage: bun apps/web/src/publish.ts --input=articles.json [--write]");
  const records = buildRecords(uri, origin, await Bun.file(input).json(), {
    name: "Ephyra journal",
    description: "Notes on building self-driving software: trails, proof, landing on forges you own, and jellyware.",
  });
  const { did } = publicationIdentity(uri);
  if (!process.argv.includes("--write")) {
    console.log(JSON.stringify({ repo: did, records }, null, 2));
    process.exit(0);
  }
  const password = process.env.EPHYRA_BLOG_APP_PASSWORD;
  if (!password) throw new Error("Inject EPHYRA_BLOG_APP_PASSWORD from a secret store.");
  const pds = publicOrigin(process.env.EPHYRA_BLOG_PDS_ORIGIN ?? "https://pds.notorganic.info");
  for (const written of await writeRecords(pds, did, password, records)) console.log(`Verified ${written}`);
}
