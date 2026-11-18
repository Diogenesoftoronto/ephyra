import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  evidenceCoverage, evidenceSourceSummary, isEvidenceSourcePath, readDecisionRecord, readEvidenceIndex, readEvidenceSource,
} from "../src/review-records.ts";

const PREFIX = "evidence/research/0001/0123456789abcdef";
const manifest = {
  schema: 1, trail: "t", rev: 1, query: "TotalMismatch", configuredSources: 4, queriedSources: 3, omittedSources: 0,
  records: [`${PREFIX}/source-00.json`, `${PREFIX}/source-01.json`, "../../etc/passwd", `${PREFIX}/index.json`],
  limitation: "Available means readable evidence, not proof of correctness or healthy service.",
};
const hit = (over: object = {}) => ({
  status: "available", reference: { source: "otel", id: "e1", revision: null, uri: "https://otel.example/e1" },
  title: "TotalMismatch in sumLineItems", snippet: "charged 4199 ≠ cart 4198", score: 0.97, content: "secret body", ...over,
});
const source = (over: object = {}) => ({
  source: "otel", status: "available", requestedAt: "2026-11-07T19:06:00.000Z", completedAt: "2026-11-07T19:06:01.000Z",
  query: { text: "TotalMismatch", limit: 3 }, scope: {}, hits: [hit()], omittedHits: 0, ...over,
});

test("the research manifest reads as coverage and keeps only per-source record paths", () => {
  expect(readEvidenceIndex(JSON.stringify(manifest))).toEqual({
    kind: "coverage", query: "TotalMismatch", configured: 4, queried: 3, omitted: 0,
    records: [`${PREFIX}/source-00.json`, `${PREFIX}/source-01.json`], limitation: manifest.limitation,
  });
  expect(isEvidenceSourcePath(`${PREFIX}/source-07.json`)).toBe(true);
  expect(isEvidenceSourcePath(`${PREFIX}/index.json`) || isEvidenceSourcePath("evidence/index.json")).toBe(false);
});

test("a plain hit list, bare or under `hits`, reads as hits; anything else is left to the file", () => {
  const hits = [{ source: "git", title: "8c1e0f2 show per-line discounts", snippet: "round each line", score: 0.91 }];
  expect(readEvidenceIndex(JSON.stringify(hits))).toEqual({ kind: "hits", hits });
  expect(readEvidenceIndex(JSON.stringify({ hits }))).toEqual({ kind: "hits", hits });
  expect(readEvidenceIndex("[]")).toEqual({ kind: "hits", hits: [] });
  for (const bad of ["", "not json", "null", "{}", "[{\"title\":1}]", "{\"records\":[]}"]) expect(readEvidenceIndex(bad)).toBeNull();
});

test("a source record keeps its status, reasons and references, and never the fetched content", () => {
  const view = readEvidenceSource(JSON.stringify(source({ status: "partial", omittedHits: 2, hits: [hit(),
    hit({ status: "unavailable", reason: "The evidence source returned unsupported content.", reference: { source: "otel", id: "e2", revision: "r9", uri: null } })] })));
  expect(view).toEqual({
    source: "otel", status: "partial", omittedHits: 2, completedAt: "2026-11-07T19:06:01.000Z",
    hits: [
      { source: "otel", title: "TotalMismatch in sumLineItems", snippet: "charged 4199 ≠ cart 4198", score: 0.97, status: "available",
        uri: "https://otel.example/e1" },
      { source: "otel", title: "TotalMismatch in sumLineItems", snippet: "charged 4199 ≠ cart 4198", score: 0.97, status: "unavailable",
        revision: "r9", reason: "The evidence source returned unsupported content." },
    ],
  });
  expect(JSON.stringify(view)).not.toContain("secret body");
  expect(evidenceSourceSummary(view!)).toBe("2 hits · 1 could not be fetched · 2 more not recorded");
  expect(readEvidenceSource(JSON.stringify({ source: "otel", status: "fine", hits: [], omittedHits: 0 }))).toBeNull();
});

test("an unavailable source says why, an empty one says so, and neither counts as having hits", () => {
  const down = readEvidenceSource(JSON.stringify(source({ status: "unavailable", hits: [], reason: "The evidence source did not finish within its read deadline." })))!;
  const empty = readEvidenceSource(JSON.stringify(source({ status: "empty", hits: [] })))!;
  const ok = readEvidenceSource(JSON.stringify(source()))!;
  expect(evidenceSourceSummary(down)).toBe("The evidence source did not finish within its read deadline.");
  expect(evidenceSourceSummary(readEvidenceSource(JSON.stringify(source({ status: "unavailable", hits: [] })))!)).toBe("No reason recorded.");
  expect(evidenceSourceSummary(empty)).toBe("No matches.");
  expect(evidenceSourceSummary(ok)).toBe("1 hit");
  expect(evidenceCoverage([down, empty, ok, ok])).toEqual({ withHits: 2, empty: 1, unavailable: 1 });
});

test("a decided checkpoint record reads as its verdict, the model and each answer", () => {
  const view = readDecisionRecord(JSON.stringify({
    status: "decided", operationKey: "checkpoint:abc", answeredAt: "2026-11-07T19:40:00.000Z", bound: { rev: 1 },
    request: { state: { trail: "…" }, questions: { verdict: { type: "choice", instructions: "Is the cause supported by the evidence?", criteria: {} } } },
    response: { model: "judgement-jev/jev-1.14", answers: { verdict: { type: "choice", choice: "approve", probabilities: { approve: 0.9 }, confidence: 0.9 } } },
    decision: { by: "policy", at: "2026-11-07T19:40:00.000Z", verdict: "approve", backend: "judgement-jev/jev-1.14" },
  }));
  expect(view).toEqual({
    status: "decided", model: "judgement-jev/jev-1.14", answeredAt: "2026-11-07T19:40:00.000Z", bound: { rev: 1 },
    decision: { by: "policy", at: "2026-11-07T19:40:00.000Z", verdict: "approve", backend: "judgement-jev/jev-1.14" },
    answers: [{ id: "verdict", instructions: "Is the cause supported by the evidence?", answer: "approve", confidence: 0.9 }],
  });
});

test("a halted record keeps its reason and has no decision; unreadable records are left to the file", () => {
  expect(readDecisionRecord(JSON.stringify({ status: "unavailable", checkpoint: "B", bound: { rev: 2, head: "abc" },
    reason: "Checkpoint B needs complete evidence for the current revision and policy area." }))).toEqual({
    status: "unavailable", checkpoint: "B", bound: { rev: 2, head: "abc" }, answers: [],
    reason: "Checkpoint B needs complete evidence for the current revision and policy area.",
  });
  expect(readDecisionRecord(JSON.stringify({ status: "unresolved", decision: null, response: { model: "m", answers: {} } }))).toEqual({
    status: "unresolved", model: "m", answers: [] });
  for (const bad of ["", "[]", "{}", "{\"status\":1}", JSON.stringify({ status: "decided", response: { model: "m", answers: { v: { type: "essay" } } } })]) {
    expect(readDecisionRecord(bad)).toBeNull();
  }
});

test("property: no reader throws, whatever the text", () => {
  fc.assert(fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
    readEvidenceIndex(text); readEvidenceSource(text); readDecisionRecord(text);
  }));
});

test("property: a source is never reported with more hits than its record holds, and its status is the record's", () => {
  const status = fc.constantFrom("available", "empty", "partial", "unavailable");
  fc.assert(fc.property(status, fc.array(fc.constantFrom("available", "partial", "unavailable"), { maxLength: 3 }), fc.nat(50), (state, hits, omitted) => {
    const view = readEvidenceSource(JSON.stringify(source({ status: state, omittedHits: omitted, hits: hits.map((s) => hit({ status: s })) })))!;
    expect(view.status).toBe(state);
    expect(view.hits.map((h) => h.status)).toEqual(hits);
    expect(view.omittedHits).toBe(omitted);
  }));
});
