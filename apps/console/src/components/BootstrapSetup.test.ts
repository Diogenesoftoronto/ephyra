import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BootstrapAssessment, type SetupRun } from "@ephyra/core";
import { SETUP_FIXTURE } from "../fake/setup.ts";
import {
  BootstrapAssessmentView, BootstrapCoverage, bootstrapAnswerRecorded, bootstrapAnswerSuperseded, bootstrapScope,
  forgetBootstrapAnswer, pendingBootstrapAnswers, rememberBootstrapAnswer,
} from "./BootstrapSetup.tsx";

const setupId = "a".repeat(32);
const head = "b".repeat(40);
const requestId = "c".repeat(64);
const at = "2026-11-08T12:00:00.000Z";
const assessment = () => BootstrapAssessment.parse({
  schema: 1, setupId, head, assessedAt: at, nextAssessmentAt: "2026-11-08T12:05:00.000Z",
  sources: [{ path: "README.md", commit: head, digest: "d".repeat(64), kind: "documentation", excerpt: "<script>repository text</script>" }],
  coverage: [
    { id: "telemetry", status: "configured", summary: "A connection is saved; ingestion has not been observed.", references: [] },
    { id: "deployment", status: "unknown", summary: "No deployed revision is recorded.", references: [] },
  ],
  requests: [{ id: requestId, kind: "context", status: "open", question: "What should a successful booking do?",
    options: ["Create a booking and show its confirmation."], createdAt: at, updatedAt: at }],
  contextReports: [],
});
const run = (): SetupRun => ({ ...structuredClone(SETUP_FIXTURE), id: setupId,
  repository: { ...SETUP_FIXTURE.repository, head }, bootstrap: assessment() });

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});
function storage() {
  const rows = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    get length() { return rows.size; }, key: (index: number) => [...rows.keys()][index] ?? null,
    getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
  } });
  return rows;
}

test("bootstrap coverage distinguishes a saved connection from observed ingestion and escapes source content", () => {
  const html = renderToStaticMarkup(createElement(BootstrapAssessmentView, { run: run() }));
  expect(html).toContain("Connected, awaiting observation");
  expect(html).toContain("Unverified");
  expect(html).toContain("2026-11-08 12:00:00 UTC");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;repository text&lt;/script&gt;");
  expect(html).not.toContain("All systems healthy");
  const compact = renderToStaticMarkup(createElement(BootstrapCoverage, { assessment: assessment(), compact: true }));
  expect(compact).toContain("Connected, awaiting observation");
  expect(compact).not.toContain("Inspect references");
});

test("legacy setup runs explain that an observation assessment is absent", () => {
  const html = renderToStaticMarkup(createElement(BootstrapAssessmentView, { run: SETUP_FIXTURE }));
  expect(html).toContain("observation assessment has not been recorded");
  expect(html).toContain("#/onboarding");
  expect(html).not.toContain("Next check");
});

test("pending bootstrap answers keep only exact operation metadata and remain isolated by account and workspace", () => {
  const rows = storage();
  const scope = bootstrapScope("did:example:owner", "workspace-one");
  const pending = { setupId, head, requestId, operationKey: "bootstrap-answer:one" };
  rememberBootstrapAnswer(scope, { ...pending, text: "never persist this answer" } as typeof pending);
  expect(pendingBootstrapAnswers(scope)).toEqual([pending]);
  expect(JSON.stringify([...rows.values()])).not.toContain("never persist");
  expect(pendingBootstrapAnswers(bootstrapScope("did:example:other", "workspace-one"))).toEqual([]);
  expect(pendingBootstrapAnswers(bootstrapScope("did:example:owner", "workspace-two"))).toEqual([]);
  rows.set(`${scope}malformed`, JSON.stringify(pending));
  expect(pendingBootstrapAnswers(scope)).toEqual([pending]);
  forgetBootstrapAnswer(scope, pending);
  expect(pendingBootstrapAnswers(scope)).toEqual([]);
});

test("recovery requires the same setup, SHA, request and operation key rather than any answered request", () => {
  const saved = run();
  const pending = { setupId, head, requestId, operationKey: "bootstrap-answer:one" };
  expect(bootstrapAnswerRecorded(saved, pending)).toBe(false);
  saved.bootstrap!.requests[0]!.answer = { text: "Send the booking confirmation.", kind: "human", by: "did:example:owner",
    at, operationKey: pending.operationKey, digest: "e".repeat(64) };
  expect(bootstrapAnswerRecorded(saved, pending)).toBe(true);
  for (const changed of [
    { setupId: "f".repeat(32) }, { head: "f".repeat(40) }, { requestId: "f".repeat(64) }, { operationKey: "bootstrap-answer:other" },
  ]) expect(bootstrapAnswerRecorded(saved, { ...pending, ...changed })).toBe(false);
  saved.bootstrap!.head = "f".repeat(40);
  expect(bootstrapAnswerRecorded(saved, pending)).toBe(false);
});

test("a replaced setup clears an unanswered pending request only after reading its exact historical record", () => {
  const old = run();
  const pending = { setupId, head, requestId, operationKey: "bootstrap-answer:one" };
  const current = { ...run(), id: "f".repeat(32) };
  expect(bootstrapAnswerSuperseded(current, old, pending)).toBe(true);
  expect(bootstrapAnswerSuperseded(current, null, pending)).toBe(false);
  expect(bootstrapAnswerSuperseded(old, old, pending)).toBe(false);
  expect(bootstrapAnswerSuperseded(current, { ...old, repository: { ...old.repository, head: "f".repeat(40) } }, pending)).toBe(false);
  old.bootstrap!.requests[0]!.answer = { text: "An attributed answer", kind: "human", by: "did:example:owner", at,
    operationKey: "bootstrap-answer:different", digest: "e".repeat(64) };
  expect(bootstrapAnswerSuperseded(current, old, pending)).toBe(false);
});
