import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionRecord, EvidenceCoverage, decisionHeadline, evidenceHeadline } from "./ReviewRecords.tsx";
import { ReviewEvidence } from "./ReviewEvidence.tsx";
import { DECISION_ARTEFACTS, EVIDENCE_ARTEFACTS } from "../fake/documents.ts";

const [index, ...records] = EVIDENCE_ARTEFACTS;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("each source is a row with its own status, and an unavailable source says why instead of looking read", () => {
  const html = renderToStaticMarkup(createElement(EvidenceCoverage, { index: index!.content, records }));
  const page = text(html);
  expect(page).toContain("4 of 4 configured sources queried");
  expect(page).toContain("otel partial 2 hits · 1 could not be fetched · 5 more not recorded");
  expect(page).toContain("git available 1 hit");
  expect(page).toContain("trails empty No matches.");
  expect(page).toContain("entire unavailable The evidence source did not finish within its read deadline.");
  expect(page).toContain("content not fetched");
  expect(page).toContain("Available means readable evidence, not proof of correctness");
  expect(html).not.toContain("review-document");
  expect(evidenceHeadline(index!.content, records)).toBe("Research sources · 2 with hits · 1 empty · 1 unavailable");
});

test("source records that were not sent are counted as not loaded, and the heading claims no coverage for them", () => {
  const html = text(renderToStaticMarkup(createElement(EvidenceCoverage, { index: index!.content, records: records.slice(0, 1) })));
  expect(html).toContain("3 source records named by the index were not loaded, so they are not shown here.");
  expect(html).not.toContain("git available");
  expect(evidenceHeadline(index!.content, records.slice(0, 1))).toBe("Research sources · 4 of 4 queried");
  const broken = text(renderToStaticMarkup(createElement(EvidenceCoverage, { index: index!.content,
    records: [{ path: records[0]!.path, content: "{}" }] })));
  expect(broken).toContain("This record is not in a form this page can read.");
});

test("a plain hit list is a list, hostile text stays text, and an unrecognized index stays a file", () => {
  const hits = JSON.stringify([{ source: "otel", title: "<img src=x onerror=alert(1)>", snippet: "<script>x</script>", score: 0.5 }]);
  const html = renderToStaticMarkup(createElement(EvidenceCoverage, { index: hits, records: [] }));
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
  expect(text(html)).toContain("0.50");
  expect(evidenceHeadline(hits, [])).toBe("Evidence · 1 hit");
  expect(renderToStaticMarkup(createElement(EvidenceCoverage, { index: "{\"x\":1}", records: [] }))).toContain("review-document");
  expect(evidenceHeadline("{\"x\":1}", [])).toBe("Research source coverage");
});

test("a decided record shows the verdict, the model and the answer; a stopped one never shows a verdict", () => {
  const decided = text(renderToStaticMarkup(createElement(DecisionRecord, { content: DECISION_ARTEFACTS[0]!.content })));
  expect(decided).toContain("Outcome approve recorded 19:40 UTC");
  expect(decided).toContain("judgement-jev/jev-1.14");
  expect(decided).toContain("Does the evidence support this cause well enough to reproduce it? approve confidence 0.93");
  expect(decisionHeadline("decisions/latest-A.json", DECISION_ARTEFACTS[0]!.content)).toBe("Machine checkpoint A · approve");
  const stopped = text(renderToStaticMarkup(createElement(DecisionRecord, { content: DECISION_ARTEFACTS[1]!.content })));
  expect(stopped).toContain("Outcome unavailable No decision was recorded.");
  expect(stopped).toContain("Checkpoint B needs complete evidence");
  expect(stopped).not.toContain("approve");
  expect(decisionHeadline("decisions/latest-B.json", DECISION_ARTEFACTS[1]!.content)).toBe("Machine checkpoint B · unavailable");
  expect(decisionHeadline("decisions/latest-C.json", "nope")).toBe("Machine checkpoint C");
  expect(renderToStaticMarkup(createElement(DecisionRecord, { content: "nope" }))).toContain("review-document");
});

test("the quest's review section lists sources once and does not print their records as documents", () => {
  const html = renderToStaticMarkup(createElement(ReviewEvidence, { artefacts: [...EVIDENCE_ARTEFACTS, ...DECISION_ARTEFACTS] }));
  expect(html).toContain("<summary>Research sources · 2 with hits · 1 empty · 1 unavailable</summary>");
  expect(html).toContain("<summary>Machine checkpoint A · approve</summary>");
  expect(html).not.toContain("source-00.json");
  expect(html).not.toContain("&quot;requestedAt&quot;");
});
