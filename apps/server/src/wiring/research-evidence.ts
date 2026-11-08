import { createHash } from "node:crypto";
import { Unverified, type EvidenceHit, type EvidenceSource, type Trail } from "@ephyra/core";
import { redact } from "@ephyra/agent";

export type ResearchEvidenceOptions = {
  secrets?: string[];
  /** Deadline per source, including fetches. Underlying adapters must also bound/cancel their own I/O. */
  timeoutMs?: number;
  now?: () => Date;
};
export type ResearchEvidence = { untrusted: Record<string, string>; files: Record<string, string> };
type HitRecord = {
  status: "available" | "partial" | "unavailable";
  reference: { source: string; id: string; revision: string | null; uri: string | null };
  title: string;
  snippet: string;
  score: number;
  mediaType?: string;
  content?: string;
  contentSha256?: string;
  truncated?: boolean;
  redacted?: boolean;
  reason?: string;
};
type SourceRecord = {
  source: string;
  status: "available" | "empty" | "partial" | "unavailable";
  requestedAt: string;
  completedAt: string;
  query: { text: string; fingerprint?: string; limit: number };
  scope: { trail: string; repo: string; rev: number; head: string; sourceBinding: "server_configured" };
  hits: HitRecord[];
  omittedHits: number;
  reason?: string;
};
const MAX_SOURCES = 8;
const MAX_HITS = 3;
const MAX_CONTENT = 4000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
const timestamp = (options: ResearchEvidenceOptions) => (options.now?.() ?? new Date()).toISOString();
const clean = (value: string, options: ResearchEvidenceOptions, limit = 1000) => redact(value, options.secrets ?? [], limit);
const unavailable = (error: unknown, options: ResearchEvidenceOptions) => error instanceof Unverified
  ? clean(error.feature, options, 500) : "The configured evidence source could not be read.";
class EvidenceTimeout extends Error {}

function validHit(value: unknown, source: string): value is EvidenceHit {
  if (!value || typeof value !== "object") return false;
  const h = value as EvidenceHit;
  return h.source === source && typeof h.id === "string" && h.id.length > 0 && h.id.length <= 2000
    && typeof h.title === "string" && h.title.length <= 8000 && typeof h.snippet === "string" && h.snippet.length <= 64_000
    && typeof h.score === "number" && Number.isFinite(h.score)
    && (h.revision === undefined || typeof h.revision === "string" && h.revision.length <= 2000)
    && (h.uri === undefined || typeof h.uri === "string" && h.uri.length <= 2000);
}

function reference(hit: EvidenceHit, options: ResearchEvidenceOptions): HitRecord["reference"] {
  return {
    source: clean(hit.source, options, 300), id: clean(hit.id, options, 2000),
    revision: hit.revision === undefined ? null : clean(hit.revision, options, 2000),
    uri: hit.uri === undefined ? null : clean(hit.uri, options, 2000),
  };
}

async function collect(
  source: EvidenceSource, trail: Trail, text: string, options: ResearchEvidenceOptions,
): Promise<{ record: SourceRecord; timedOut: boolean }> {
  const record: SourceRecord = {
    source: clean(source.name, options, 300), status: "unavailable", requestedAt: timestamp(options), completedAt: timestamp(options),
    query: { text, ...(trail.signalFingerprint ? { fingerprint: clean(trail.signalFingerprint, options) } : {}), limit: MAX_HITS },
    scope: { trail: trail.id, repo: clean(trail.repo, options, 200), rev: trail.rev,
      head: trail.head ?? trail.base.sha, sourceBinding: "server_configured" },
    hits: [], omittedHits: 0,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new EvidenceTimeout()); }, options.timeoutMs ?? 10_000);
  });
  const work = async () => {
    const operationKey = `research:${hash(JSON.stringify([trail.id, trail.repo, trail.rev, trail.head ?? trail.base.sha, text]))}`;
    const found = await source.search({ ...record.query, operationKey });
    if (expired) return;
    if (!Array.isArray(found) || found.length > 1000 || found.some((hit) => !validHit(hit, source.name))) {
      throw new Unverified("The evidence source returned unsupported search records.");
    }
    record.omittedHits = Math.max(0, found.length - MAX_HITS);
    for (const hit of found.slice(0, MAX_HITS)) {
      if (expired) return;
      const entry: HitRecord = {
        status: "unavailable", reference: reference(hit, options), title: clean(hit.title, options, 300),
        snippet: clean(hit.snippet, options, 1000), score: hit.score,
      };
      try {
        // Pass the original adapter-owned reference back to that adapter, never reconstruct a fetch URL.
        const payload = await source.fetch(hit);
        if (expired) return;
        if (!payload || typeof payload.content !== "string" || typeof payload.mediaType !== "string"
          || payload.content.length > 64_000 || payload.mediaType.length > 200) throw new Unverified("The evidence source returned unsupported content.");
        const sanitized = clean(payload.content, options, Math.max(MAX_CONTENT, payload.content.length));
        entry.truncated = sanitized.length > MAX_CONTENT;
        entry.redacted = sanitized !== payload.content;
        entry.content = entry.truncated ? sanitized.slice(0, MAX_CONTENT) + "\n[truncated]" : sanitized;
        entry.mediaType = clean(payload.mediaType, options, 200);
        entry.contentSha256 = hash(entry.content);
        entry.status = entry.truncated ? "partial" : "available";
      } catch (error) {
        if (expired) return;
        entry.reason = unavailable(error, options);
      }
      record.hits.push(entry);
    }
    record.status = !found.length ? "empty"
      : record.omittedHits || record.hits.some((hit) => hit.status !== "available") ? "partial" : "available";
    if (found.length && record.hits.every((hit) => hit.status === "unavailable")) record.status = "unavailable";
  };
  try { await Promise.race([work(), deadline]); }
  catch (error) {
    record.status = "unavailable";
    record.reason = error instanceof EvidenceTimeout ? "The evidence source did not finish within its read deadline." : unavailable(error, options);
  } finally { clearTimeout(timer); record.completedAt = timestamp(options); }
  return { record, timedOut: expired };
}

/**
 * Read-only sources must be instantiated by server configuration for the trail's workspace. Nothing returned by a model
 * selects sources, credentials or origins. Every query has a durable artefact, including empty/unavailable results.
 */
export async function gatherResearchEvidence(
  sources: EvidenceSource[], trail: Trail, query: string, options: ResearchEvidenceOptions = {},
): Promise<ResearchEvidence> {
  if (!Number.isInteger(trail.rev) || trail.rev < 1) throw new Error("Invalid research revision");
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000)) {
    throw new Error("Invalid evidence deadline");
  }
  if (typeof query !== "string" || query.length > 16_000) throw new Error("Research query exceeds its limit");
  const text = clean(query, options, 1000);
  const selected = sources.slice(0, MAX_SOURCES);
  const records: SourceRecord[] = [];
  let timedOut = false;
  for (let offset = 0; offset < selected.length; offset += 3) {
    const batch = selected.slice(offset, offset + 3);
    if (timedOut) {
      for (const source of batch) records.push({
        source: clean(source.name, options, 200), status: "unavailable", requestedAt: timestamp(options), completedAt: timestamp(options),
        query: { text, limit: MAX_HITS },
        scope: { trail: trail.id, repo: clean(trail.repo, options, 200), rev: trail.rev,
          head: trail.head ?? trail.base.sha, sourceBinding: "server_configured" },
        hits: [], omittedHits: 0, reason: "Not read because earlier source I/O did not settle within its deadline.",
      });
      continue;
    }
    const results = await Promise.all(batch.map((source) => collect(source, trail, text, options)));
    records.push(...results.map((result) => result.record));
    // EvidenceSource has no cancellation port: do not fan out more work after a timed-out operation remains outstanding.
    timedOut = results.some((result) => result.timedOut);
  }
  const prefix = `evidence/research/${String(trail.rev).padStart(4, "0")}/${hash(text).slice(0, 16)}`;
  const files: Record<string, string> = {};
  const untrusted: Record<string, string> = {};
  records.forEach((record, index) => {
    const body = json(record);
    files[`${prefix}/source-${String(index).padStart(2, "0")}.json`] = body;
    untrusted[`research_source_${index + 1}`] = `<untrusted_research_evidence>${body}</untrusted_research_evidence>`;
  });
  const manifest = json({
    schema: 1, trail: trail.id, rev: trail.rev, query: text, configuredSources: sources.length,
    queriedSources: records.filter((record) => !record.reason?.startsWith("Not read because")).length,
    omittedSources: Math.max(0, sources.length - MAX_SOURCES),
    records: Object.keys(files),
    limitation: "Available means readable evidence, not proof of correctness or healthy service. Source coverage and timestamps remain authoritative.",
  });
  files[`${prefix}/index.json`] = manifest;
  files["evidence/index.json"] = manifest;
  untrusted.research_coverage = `<untrusted_research_evidence>${manifest}</untrusted_research_evidence>`;
  return { untrusted, files };
}
