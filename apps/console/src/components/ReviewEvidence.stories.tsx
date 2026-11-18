import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewEvidence } from "./ReviewEvidence.tsx";
import { fixtureProof } from "../fake/fixtures.ts";
import { trailByShort, NOW } from "../storybook/data.ts";
import { QUESTION_FIXTURE } from "../fake/connections.ts";
import { DECISION_ARTEFACTS, EVIDENCE_ARTEFACTS, HYPOTHESIS, PLAN } from "../fake/documents.ts";
const meta: Meta = { title: "Components/ReviewEvidence" };
export default meta;
export const Proof: StoryObj = {
  render: () => <ReviewEvidence proof={fixtureProof(trailByShort("c2d018"), NOW)} />,
};
export const AwaitingHumanApproval: StoryObj = {
  render: () => <ReviewEvidence proof={{ ...fixtureProof(trailByShort("c2d018"), NOW), awaitingHumanC: true }} />,
};
export const Documents: StoryObj = {
  render: () => <ReviewEvidence artefacts={[{ path: "hypothesis.md", content: HYPOTHESIS }, { path: "plan.md", content: PLAN }]} />,
};
export const SourcesAndDecisions: StoryObj = {
  render: () => <ReviewEvidence artefacts={[...EVIDENCE_ARTEFACTS, ...DECISION_ARTEFACTS]} />,
};
export const SourceRecordsNotLoaded: StoryObj = {
  render: () => <ReviewEvidence artefacts={EVIDENCE_ARTEFACTS.slice(0, 2)} />,
};
export const Unavailable: StoryObj = {
  render: () => <ReviewEvidence artefacts={[{ path: "hypothesis.md", content: null }]} />,
};
export const InvestigationQuestion: StoryObj = {
  render: () => <ReviewEvidence artefacts={[{ path: "questions/latest.json", content: JSON.stringify(QUESTION_FIXTURE) }]} />,
};
