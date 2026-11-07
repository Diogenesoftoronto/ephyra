// Standard.site on AT Protocol: read a publication and its documents from the owner's PDS, without credentials.
// Same model as voxq's blog (voxq/blog/standard.ts): publication at at://<did>/site.standard.publication/<rkey>,
// documents in site.standard.document whose `site` is that URI and whose `path` is /posts/<slug>.
export const PUBLICATION = "site.standard.publication";
export const DOCUMENT = "site.standard.document";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type PublicationRecord = { uri: string; cid?: string; value: { $type: string; url: string; name: string; description?: string } };
export type DocumentRecord = {
  uri: string;
  cid?: string;
  value: { $type: string; site: string; path: string; title: string; description?: string; textContent: string; publishedAt: string; tags?: string[] };
};
export type Publication = { publication: PublicationRecord; posts: DocumentRecord[] };

export function publicationIdentity(uri: string): { did: string; rkey: string } {
  const m = /^at:\/\/(did:plc:[a-z2-7]{24})\/site\.standard\.publication\/([a-zA-Z0-9._~:-]{1,512})$/.exec(uri);
  if (!m) throw new Error("A real Standard.site publication URI is required.");
  return { did: m[1]!, rkey: m[2]! };
}

/** A bare HTTPS origin (loopback HTTP allowed for local development). */
export function publicOrigin(value: string): string {
  const u = new URL(value);
  const loopback = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  if (!(u.protocol === "https:" || loopback) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new Error("A canonical HTTPS origin is required.");
  }
  return u.origin;
}

export function articlePath(value: unknown): value is string {
  return typeof value === "string" && /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 200;
}

async function readJson(fetcher: Fetcher, url: string): Promise<any> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`Publication source unavailable (HTTP ${res.status}).`);
  return res.json();
}

export async function resolvePds(fetcher: Fetcher, did: string): Promise<string> {
  const doc = await readJson(fetcher, `https://plc.directory/${encodeURIComponent(did)}`);
  if (doc.id !== did) throw new Error("DID document does not match the publication.");
  const service = (doc.service ?? []).find((s: any) =>
    (s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`) && s.type === "AtprotoPersonalDataServer");
  return publicOrigin(service?.serviceEndpoint);
}

function validDocument(record: any, uri: string, did: string): record is DocumentRecord {
  const v = record?.value;
  return v?.$type === DOCUMENT && v.site === uri && articlePath(v.path) &&
    typeof v.title === "string" && v.title.trim().length > 0 && typeof v.textContent === "string" &&
    (v.description === undefined || typeof v.description === "string") &&
    typeof v.publishedAt === "string" && Number.isFinite(Date.parse(v.publishedAt)) &&
    (v.tags === undefined || (Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === "string"))) &&
    typeof record.uri === "string" && record.uri.startsWith(`at://${did}/${DOCUMENT}/`);
}

/** Publication + public (not future-dated) posts, newest first. Records that fail validation are skipped, not fatal. */
export async function readPublication(uri: string, canonical: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<Publication> {
  const { did, rkey } = publicationIdentity(uri);
  const pds = await resolvePds(fetcher, did);
  const get = new URL("/xrpc/com.atproto.repo.getRecord", pds);
  get.search = new URLSearchParams({ repo: did, collection: PUBLICATION, rkey }).toString();
  const publication = await readJson(fetcher, get.href);
  const v = publication?.value;
  if (publication?.uri !== uri || v?.$type !== PUBLICATION || typeof v.name !== "string" ||
      publicOrigin(v.url) !== publicOrigin(canonical)) {
    throw new Error("Publication identity or canonical domain does not match.");
  }
  const posts: DocumentRecord[] = [];
  const paths = new Set<string>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const list = new URL("/xrpc/com.atproto.repo.listRecords", pds);
    list.search = new URLSearchParams({ repo: did, collection: DOCUMENT, limit: "100", ...(cursor ? { cursor } : {}) }).toString();
    const page = await readJson(fetcher, list.href);
    if (!Array.isArray(page.records)) throw new Error("Invalid publication feed.");
    for (const record of page.records) {
      if (!validDocument(record, uri, did)) continue;
      if (Date.parse(record.value.publishedAt) > now) continue; // scheduled, not yet public
      if (paths.has(record.value.path)) continue; // first wins; duplicates never shadow an earlier post
      paths.add(record.value.path);
      posts.push(record);
    }
    cursor = page.cursor;
    if (cursor && seen.has(cursor)) throw new Error("Repeated publication cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor && seen.size < 50);
  posts.sort((a, b) => Date.parse(b.value.publishedAt) - Date.parse(a.value.publishedAt));
  return { publication, posts };
}
