import type { AccountSettings, InvestigationQuestion } from "@ephyra/core";
import { ACCOUNT_FIXTURE } from "./account.ts";
import { makeTrails, STORY_NOW } from "./fixtures.ts";

/** Explicit fixtures; no hosted provider, telemetry project, delivery bridge or model was contacted. */
export const CONNECTION_ACCOUNT_FIXTURE: AccountSettings = {
  ...ACCOUNT_FIXTURE,
  automation: { provider: "railway", configured: true, detail: "Fictional fixture: hosted runner configuration is present; no job has run." },
  telemetry: {
    enabled: true, workspaceId: ACCOUNT_FIXTURE.workspaceId, provider: "posthog", origin: "https://posthog.example.com", projectId: "42",
    keyConfigured: true, includeRecordings: false, status: "saved", checkedAt: null, detail: "Fictional connection, not verified against PostHog.",
  },
  people: { enabled: true, workspaceId: ACCOUNT_FIXTURE.workspaceId, contacts: [
    { id: "workspace-owner", alias: "Workspace owner", did: ACCOUNT_FIXTURE.did, roles: ["maintainer", "operator"], areas: [] },
    { id: "fixture-product", alias: "Product contact", roles: ["product"], areas: ["onboarding"] },
  ], webhookUrl: "https://delivery.example.com/questions", keyConfigured: true, updatedAt: "2026-11-08T12:00:00.000Z" },
};
export const QUESTION_FIXTURE: InvestigationQuestion = {
  id: "e".repeat(64), trailId: makeTrails(STORY_NOW)[0]!.id, workspaceId: ACCOUNT_FIXTURE.workspaceId,
  bound: { rev: 2, head: "a".repeat(40) }, status: "awaiting_answer",
  question: "Fictional question: should a newly invited teammate see archived projects?",
  reason: "Fixture: the repository does not specify this account rule.",
  acceptance: "Fixture: state the intended visibility for a new teammate.",
  recipient: CONNECTION_ACCOUNT_FIXTURE.people!.contacts[0]!, createdAt: "2026-11-08T12:00:00.000Z", updatedAt: "2026-11-08T12:00:00.000Z",
  delivery: { kind: "inbox", status: "sent" },
  checks: [{ phase: "question", model: "fixture/not-a-live-model", accepted: true,
    request: { fixture: "Question appropriateness check" }, response: { fixture: true, verdict: "accept" } }],
};
