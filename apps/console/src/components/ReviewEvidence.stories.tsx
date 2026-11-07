import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewEvidence } from "./ReviewEvidence.tsx";
import { fixtureProof } from "../fake/fixtures.ts";
import { trailByShort, NOW } from "../storybook/data.ts";
const meta: Meta = { title: "Components/ReviewEvidence" };
export default meta;
export const Proof: StoryObj = {
  render: () => <ReviewEvidence proof={fixtureProof(trailByShort("c2d018"), NOW)} />,
};
export const Unavailable: StoryObj = {
  render: () => <ReviewEvidence artefacts={[{ path: "hypothesis.md", content: null }]} />,
};
