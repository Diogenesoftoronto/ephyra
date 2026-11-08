import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionRecord, questionStatus } from "./InvestigationQuestions.tsx";
import { QUESTION_FIXTURE } from "../fake/connections.ts";
import { FakeApi } from "../fake/api.ts";
import { ReviewEvidence } from "./ReviewEvidence.tsx";

test("question evidence is escaped, actual checks are visible and historical records do not offer an answer write", () => {
  const html = renderToStaticMarkup(createElement(QuestionRecord, { question: { ...QUESTION_FIXTURE,
    question: "<script>window.pwned=true</script>", delivery: { kind: "webhook", status: "uncertain" },
    checks: [{ phase: "question", accepted: false, model: "exact/model-identity", request: "<img src=x>", response: { accepted: false } }],
  } }));
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Question check: not accepted");
  expect(html).toContain("exact/model-identity");
  expect(html).toContain("delivery unconfirmed");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Send answer");
});

test("saved but unchecked answers and rejected checks do not become accepted evidence", () => {
  const saved = { ...QUESTION_FIXTURE, answer: { text: "An answer", by: "did:plc:owner", at: "2026-11-08T12:00:00Z", accepted: false } };
  expect(questionStatus(saved)).toBe("Checking the saved answer");
  expect(questionStatus({ ...saved, status: "answered" })).toBe("Answer acceptance unconfirmed");
  expect(renderToStaticMarkup(createElement(QuestionRecord, { question: saved }))).toContain("Acceptance has not been confirmed");
  const rejected = { ...saved, checks: [...saved.checks,
    { phase: "answer" as const, accepted: false, model: "fixture/check", request: null, response: null }] };
  expect(renderToStaticMarkup(createElement(QuestionRecord, { question: rejected }))).toContain("answer check did not accept");
});

test("question fixture answers require the addressed account and do not silently replace a prior reply", async () => {
  const other = new FakeApi({ questions: [QUESTION_FIXTURE], principal: "did:plc:other" });
  await expect(other.answerQuestion(QUESTION_FIXTURE.trailId, QUESTION_FIXTURE.id, { text: "Wrong person" }, "wrong"))
    .rejects.toThrow();
  const owner = new FakeApi({ questions: [QUESTION_FIXTURE], principal: QUESTION_FIXTURE.recipient!.did });
  const result = await owner.answerQuestion(QUESTION_FIXTURE.trailId, QUESTION_FIXTURE.id, { text: "Fixture fact" }, "answer-once");
  expect(result.answer?.text).toBe("Fixture fact");
  expect(result.checks.at(-1)?.model).toBe("fixture/not-a-live-model");
  await expect(owner.answerQuestion(QUESTION_FIXTURE.trailId, QUESTION_FIXTURE.id, { text: "Replacement" }, "different"))
    .rejects.toThrow();
});

test("historical trail questions render validated records and preserve unrecognized data as escaped text", () => {
  const record = renderToStaticMarkup(createElement(ReviewEvidence, {
    artefacts: [{ path: "questions/latest.json", content: JSON.stringify(QUESTION_FIXTURE) }],
  }));
  expect(record).toContain("Investigation question and checks");
  expect(record).toContain("fixture/not-a-live-model");
  expect(record).not.toContain("Send answer");
  const invalid = renderToStaticMarkup(createElement(ReviewEvidence, {
    artefacts: [{ path: "questions/latest.json", content: '<script>untrusted content</script>' }],
  }));
  expect(invalid).toContain("&lt;script&gt;");
  expect(invalid).not.toContain("<script>");
  expect(invalid).not.toContain("Question check: accepted");
});
