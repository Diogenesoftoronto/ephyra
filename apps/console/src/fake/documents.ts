/** Sample checkpoint documents, written the way an agent writes them. Fixture text only. */
export const HYPOTHESIS = `# Hypothesis
\`sumLineItems\` rounds each line to whole cents before adding them up, so a cart of discounted lines can total a cent less than the amount charged.

## Evidence
- 37 failures since 14:02, every one a cart with three or more discounted lines
- Started with 8c1e0f2, "show per-line discounts"
- No earlier quest touched total.ts

## Competing causes
- The payments adapter truncates instead of rounding. Ruled out: the charge matches the receipt.

## Next
Reproduce with three lines at 33⅓% off, then round once, at the end.`;

export const PLAN = `# Plan
1. Keep line totals in integer micro-cents; round once, in \`cartTotal\`.
2. Add the probe \`checkout/one-cent-drift\`; it fails on base.
3. Leave the receipt's display rounding alone.

Touches: services/checkout/src/total.ts, total.test.ts
Not touching: the payments adapter.

## Risks
- A cart saved before the change holds rounded lines. They are re-summed on load.

## Verification
\`\`\`sh
bun test services/checkout
\`\`\``;

const RESEARCH = "evidence/research/0001/0123456789abcdef";
const hit = (source: string, id: string, title: string, snippet: string, score: number, more: object = {}) => ({
  status: "available", reference: { source, id, revision: null, uri: null }, title, snippet, score, ...more,
});
const record = (source: string, status: string, hits: object[], more: object = {}) => JSON.stringify({
  source, status, requestedAt: "2026-11-07T19:06:00.000Z", completedAt: "2026-11-07T19:06:02.000Z",
  query: { text: "TotalMismatch in sumLineItems", limit: 3 }, hits, omittedHits: 0, ...more,
}, null, 2);

/** The research evidence index and the per-source records it names, in the shapes the server writes. */
export const EVIDENCE_ARTEFACTS = [
  { path: "evidence/index.json", content: JSON.stringify({
    schema: 1, rev: 1, query: "TotalMismatch in sumLineItems", configuredSources: 4, queriedSources: 4, omittedSources: 0,
    records: [0, 1, 2, 3].map((i) => `${RESEARCH}/source-0${i}.json`),
    limitation: "Available means readable evidence, not proof of correctness or healthy service. Source coverage and timestamps remain authoritative.",
  }, null, 2) },
  { path: `${RESEARCH}/source-00.json`, content: record("otel", "partial", [
    hit("otel", "e1", "TotalMismatch in sumLineItems", "charged 4199 ≠ cart 4198 · 37 events · POST /checkout", 0.97),
    hit("otel", "e2", "Slow span in cartTotal", "p95 412 ms", 0.41, { status: "unavailable", reason: "The evidence source returned unsupported content." }),
  ], { omittedHits: 5 }) },
  { path: `${RESEARCH}/source-01.json`, content: record("git", "available", [
    hit("git", "8c1e0f2", "8c1e0f2 show per-line discounts", "total.ts: round each line before summing", 0.91, {
      reference: { source: "git", id: "8c1e0f2", revision: "8c1e0f2a9d4b", uri: null } }),
  ]) },
  { path: `${RESEARCH}/source-02.json`, content: record("trails", "empty", []) },
  { path: `${RESEARCH}/source-03.json`, content: record("entire", "unavailable", [], {
    reason: "The evidence source did not finish within its read deadline." }) },
];

const QUESTION = { verdict: { type: "choice", instructions: "Does the evidence support this cause well enough to reproduce it?", criteria: {} } };
/** Machine checkpoint records: one decided, one that stopped without a decision. */
export const DECISION_ARTEFACTS = [
  { path: "decisions/latest-A.json", content: JSON.stringify({
    status: "decided", operationKey: "checkpoint:fixture", request: { state: {}, questions: QUESTION },
    response: { model: "judgement-jev/jev-1.14",
      answers: { verdict: { type: "choice", choice: "approve", probabilities: { approve: 0.93 }, confidence: 0.93 } } },
    answeredAt: "2026-11-07T19:40:00.000Z", bound: { rev: 1 },
    decision: { by: "policy", at: "2026-11-07T19:40:00.000Z", verdict: "approve", backend: "judgement-jev/jev-1.14" },
  }, null, 2) },
  { path: "decisions/latest-B.json", content: JSON.stringify({
    status: "unavailable", checkpoint: "B", bound: { rev: 1, head: "8c1e0f2a9d4b7e6c5a3f1d0e9b8c7a6f5e4d3c2b" },
    reason: "Checkpoint B needs complete evidence for the current revision and policy area.",
  }, null, 2) },
];
