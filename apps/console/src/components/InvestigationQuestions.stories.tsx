import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { InvestigationQuestions, QuestionRecord } from "./InvestigationQuestions.tsx";
import { FakeApi } from "../fake/api.ts";
import { QUESTION_FIXTURE } from "../fake/connections.ts";
import { ACCOUNT_FIXTURE } from "../fake/account.ts";
import "./AccountForms.css";

const meta: Meta = { title: "Investigations/Questions" };
export default meta;
function Example({ principal = ACCOUNT_FIXTURE.did, rejected = false }: { principal?: string; rejected?: boolean }) {
  const [api] = useState(() => new FakeApi({ questions: [QUESTION_FIXTURE], principal, rejectQuestionAnswers: rejected }));
  return <InvestigationQuestions api={api} principal={principal} workspace={ACCOUNT_FIXTURE.workspaceId} />;
}
export const Owner: StoryObj = { render: () => <Example /> };
export const AnotherRecipient: StoryObj = { render: () => <Example principal="did:plc:other-account" /> };
export const AnswerRejected: StoryObj = { render: () => <Example rejected /> };
export const DeliveryUnconfirmed: StoryObj = { render: () => <QuestionRecord question={{ ...QUESTION_FIXTURE,
  status: "ambiguous", delivery: { kind: "webhook", status: "uncertain" },
}} /> };
export const RecordedAnswer: StoryObj = { render: () => <QuestionRecord question={{ ...QUESTION_FIXTURE,
  status: "answered", answer: { text: "Fixture: archived projects stay hidden.", by: ACCOUNT_FIXTURE.did,
    at: "2026-11-08T12:01:00.000Z", accepted: true },
  checks: [...QUESTION_FIXTURE.checks, { phase: "answer", accepted: true, model: "fixture/not-a-live-model",
    request: { fixture: "Answer consistency check" }, response: { fixture: true, verdict: "accept" } }],
}} /> };
export const Phone: StoryObj = { ...Owner, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Owner, parameters: { theme: "dark" } };
