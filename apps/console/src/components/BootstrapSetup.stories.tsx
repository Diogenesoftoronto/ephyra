import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BootstrapAssessment, BootstrapResponse, SetupRun } from "@ephyra/core";
import { ACCOUNT_FIXTURE } from "../fake/account.ts";
import { SETUP_FIXTURE } from "../fake/setup.ts";
import type { SetupApi } from "../setup-api.ts";
import { BootstrapAssessmentView, BootstrapSetup } from "./BootstrapSetup.tsx";
import "./AccountForms.css";

const meta: Meta = { title: "Account/Proactive bootstrap" };
export default meta;
const at = "2026-11-08T12:00:00.000Z";
const assessment: BootstrapAssessment = {
  schema: 1, setupId: "a".repeat(32), head: "b".repeat(40), assessedAt: at, nextAssessmentAt: "2026-11-08T12:05:00.000Z",
  sources: [{ path: "README.md", commit: "b".repeat(40), digest: "d".repeat(64), kind: "documentation",
    excerpt: "Fixture repository: users can create and manage bookings." }],
  coverage: [
    { id: "repository", status: "observed", summary: "Fixture: pinned repository documents were read.", references: ["README.md"] },
    { id: "checks", status: "missing", summary: "Fixture: baseline checks have not run.", references: [] },
    { id: "telemetry", status: "configured", summary: "Fixture: a source is configured; no fresh query is recorded.", references: [] },
    { id: "deployment", status: "unknown", summary: "Fixture: the deployed revision is unverified.", references: [] },
    { id: "knowledge", status: "missing", summary: "Fixture: no external knowledge source is selected.", references: [] },
    { id: "contact", status: "observed", summary: "Fixture: owner Inbox is enabled. No bridge delivery has been tested.", references: [] },
  ],
  requests: [{ id: "c".repeat(64), kind: "context", status: "open", question: "What should a successful booking do?",
    options: ["Create the booking and show its confirmation", "Confirm availability before saving"], createdAt: at, updatedAt: at },
  { id: "e".repeat(64), kind: "configuration", gap: "telemetry", status: "open", question: "Verify error telemetry coverage.",
    action: "Connect the scoped source and record a fresh query window.", options: [], createdAt: at, updatedAt: at }],
  contextReports: [],
};
const fixtureRun = (): SetupRun => ({ ...structuredClone(SETUP_FIXTURE), id: assessment.setupId,
  repository: { ...SETUP_FIXTURE.repository, head: assessment.head }, bootstrap: structuredClone(assessment) });

function Example({ uncertain = false }: { uncertain?: boolean }) {
  const [api] = useState<SetupApi>(() => {
    let run = fixtureRun();
    return { current: async () => structuredClone(run), record: async () => structuredClone(run), start: async () => structuredClone(run),
      reassess: async () => structuredClone(run),
      respond: async (input: BootstrapResponse, operationKey: string) => {
        const request = run.bootstrap!.requests.find(item => item.id === input.requestId)!;
        request.answer = { text: input.text, by: ACCOUNT_FIXTURE.did, kind: "human", at, operationKey, digest: "f".repeat(64) };
        request.status = "answered";
        run = structuredClone(run);
        if (uncertain) { const { UnknownWriteOutcome } = await import("../api.ts"); throw new UnknownWriteOutcome(operationKey); }
        return structuredClone(run);
      },
    };
  });
  return <BootstrapSetup api={api} principal={ACCOUNT_FIXTURE.did} workspace={ACCOUNT_FIXTURE.workspaceId} />;
}
export const Owner: StoryObj = { render: () => <Example /> };
export const InterruptedAnswer: StoryObj = { render: () => <Example uncertain /> };
export const Coverage: StoryObj = { render: () => <BootstrapAssessmentView run={fixtureRun()} /> };
export const Phone: StoryObj = { ...Owner, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Owner, parameters: { theme: "dark" } };
