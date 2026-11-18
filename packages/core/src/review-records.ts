/**
 * Readings of the journal's JSON review records (the research evidence index, its per-source records and a machine
 * checkpoint record), so an interface can show sources, hits and answers as lists instead of the raw JSON. Each reader
 * returns null for text it does not recognize, and the caller shows the file instead. A reading only selects and
 * renames fields: an unavailable source stays unavailable, and nothing is marked read, passed or decided that the
 * record does not say.
 */
import { z } from "zod";
import { Decision } from "./schemas.ts";

const text = z.string();
const HitStatus = z.enum(["available", "partial", "unavailable"]);
const SourceStatus = z.enum(["available", "empty", "partial", "unavailable"]);

export interface EvidenceHitView {
  source: string;
  title: string;
  snippet?: string;
  score?: number;
  /** Whether the hit's content was fetched. Absent on a plain hit list, which records no fetch. */
  status?: z.infer<typeof HitStatus>;
  revision?: string;
  uri?: string;
  reason?: string;
  truncated?: boolean;
  redacted?: boolean;
}

export interface EvidenceSourceView {
  source: string;
  status: z.infer<typeof SourceStatus>;
  hits: EvidenceHitView[];
  /** Hits the source returned beyond the ones recorded. */
  omittedHits: number;
  reason?: string;
  completedAt?: string;
}

export type EvidenceIndexView =
  /** The server's research manifest: how many sources were configured and read, and where each source's record is. */
  | { kind: "coverage"; query: string; configured: number; queried: number; omitted: number; records: string[]; limitation?: string }
  /** A plain list of hits, as an agent or a fixture may write it. */
  | { kind: "hits"; hits: EvidenceHitView[] };

const RECORD_PATH = /^evidence\/research\/[0-9]{4,10}\/[a-f0-9]{16}\/source-[0-9]{2}\.json$/;

const PlainHit = z.object({
  source: text, title: text, snippet: text.optional(), score: z.number().optional(), revision: text.optional(), uri: text.optional(),
});
const Manifest = z.object({
  query: text, configuredSources: z.number(), queriedSources: z.number(), omittedSources: z.number(),
  records: z.array(text), limitation: text.optional(),
});
const RecordedHit = z.object({
  status: HitStatus, title: text, snippet: text, score: z.number(),
  reference: z.object({ source: text, id: text, revision: text.nullable(), uri: text.nullable() }),
  reason: text.optional(), truncated: z.boolean().optional(), redacted: z.boolean().optional(),
});
const SourceRecord = z.object({
  source: text, status: SourceStatus, hits: z.array(RecordedHit), omittedHits: z.number(),
  reason: text.optional(), completedAt: text.optional(),
});

function json(source: string): unknown {
  try { return JSON.parse(source); } catch { return undefined; }
}
/** Drop keys whose value is absent, so a view never carries `undefined` fields. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as T;

/** Read `evidence/index.json`. The manifest's record list keeps only per-source record paths, in order. */
export function readEvidenceIndex(source: string): EvidenceIndexView | null {
  const value = json(source);
  const list = Array.isArray(value) ? value : (value as { hits?: unknown } | null | undefined)?.hits;
  if (Array.isArray(list)) {
    const hits = z.array(PlainHit).safeParse(list);
    return hits.success ? { kind: "hits", hits: hits.data.map((hit) => compact({ ...hit })) } : null;
  }
  const manifest = Manifest.safeParse(value);
  if (!manifest.success) return null;
  const m = manifest.data;
  return compact({
    kind: "coverage" as const, query: m.query, configured: m.configuredSources, queried: m.queriedSources, omitted: m.omittedSources,
    records: m.records.filter((path) => RECORD_PATH.test(path)), limitation: m.limitation,
  });
}

/** True for a path the research manifest may list as one source's record. */
export const isEvidenceSourcePath = (path: string): boolean => RECORD_PATH.test(path);

/** Read one `evidence/research/<rev>/<query>/source-NN.json` record. */
export function readEvidenceSource(source: string): EvidenceSourceView | null {
  const record = SourceRecord.safeParse(json(source));
  if (!record.success) return null;
  const r = record.data;
  return compact({
    source: r.source, status: r.status, omittedHits: r.omittedHits, reason: r.reason, completedAt: r.completedAt,
    hits: r.hits.map((hit) => compact({
      source: hit.reference.source, title: hit.title, snippet: hit.snippet || undefined, score: hit.score, status: hit.status,
      revision: hit.reference.revision ?? undefined, uri: hit.reference.uri ?? undefined, reason: hit.reason,
      truncated: hit.truncated || undefined, redacted: hit.redacted || undefined,
    })),
  });
}

/** One line on what a source's record says, for a row beside its name. */
export function evidenceSourceSummary(source: EvidenceSourceView): string {
  const more = source.omittedHits ? ` · ${source.omittedHits} more not recorded` : "";
  if (source.status === "unavailable" && !source.hits.length) return source.reason ?? "No reason recorded.";
  if (source.status === "empty") return "No matches.";
  const unread = source.hits.filter((hit) => hit.status === "unavailable").length;
  return `${source.hits.length} hit${source.hits.length === 1 ? "" : "s"}${unread ? ` · ${unread} could not be fetched` : ""}${more}`;
}

/** How many of the loaded source records are in each state, for a heading. Counts only records that were read. */
export function evidenceCoverage(sources: readonly EvidenceSourceView[]): { withHits: number; empty: number; unavailable: number } {
  return {
    withHits: sources.filter((s) => s.status === "available" || s.status === "partial").length,
    empty: sources.filter((s) => s.status === "empty").length,
    unavailable: sources.filter((s) => s.status === "unavailable").length,
  };
}

export interface DecisionAnswerView {
  id: string;
  /** The question as it was put to the model, when the record holds the request. */
  instructions?: string;
  /** The answer in words: the choice, the score, or the probability of a yes/no question. */
  answer: string;
  confidence?: number;
}

export interface DecisionRecordView {
  /** The evaluator's own status word, such as "decided", "unresolved" or "evaluating". */
  status: string;
  checkpoint?: "A" | "B" | "C";
  /** Why the evaluator stopped, when it did. */
  reason?: string;
  /** The model identity exactly as the backend returned it. */
  model?: string;
  answeredAt?: string;
  decision?: z.infer<typeof Decision>;
  bound?: { rev: number; head?: string; proofDigest?: string };
  answers: DecisionAnswerView[];
  fallback?: { from: string; to: string; reason: string };
}

const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("choice"), choice: text, confidence: z.number() }),
  z.object({ type: z.literal("score"), score: z.number(), confidence: z.number() }),
]);
const Record_ = z.object({
  status: text,
  checkpoint: z.enum(["A", "B", "C"]).optional(),
  reason: text.optional(),
  answeredAt: text.optional(),
  decision: Decision.nullable().optional(),
  bound: z.object({ rev: z.number(), head: text.optional(), proofDigest: text.optional() }).optional(),
  request: z.object({ questions: z.record(text, z.object({ instructions: text })) }).optional(),
  response: z.object({
    model: text, answers: z.record(text, Answer),
    fallback: z.object({ from: text, to: text, reason: text }).optional(),
  }).optional(),
});

/** Read a `decisions/latest-<checkpoint>.json` record. An answer the reader cannot type makes the whole record unread. */
export function readDecisionRecord(source: string): DecisionRecordView | null {
  const record = Record_.safeParse(json(source));
  if (!record.success) return null;
  const r = record.data;
  const answers = Object.entries(r.response?.answers ?? {}).map(([id, a]): DecisionAnswerView => compact({
    id, instructions: r.request?.questions[id]?.instructions,
    answer: a.type === "choice" ? a.choice : a.type === "score" ? String(a.score) : a.noul.toFixed(2),
    confidence: a.type === "noul" ? undefined : a.confidence,
  }));
  return compact({
    status: r.status, checkpoint: r.checkpoint, reason: r.reason, model: r.response?.model, answeredAt: r.answeredAt,
    decision: r.decision ?? undefined, bound: r.bound, answers, fallback: r.response?.fallback,
  });
}
