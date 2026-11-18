import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckpointDocument } from "./CheckpointDocument.tsx";
import { HYPOTHESIS, PLAN } from "../fake/documents.ts";

const meta: Meta = { title: "Components/CheckpointDocument" };
export default meta;

const LONG = `# Hypothesis\nThe cursor helper reads one page past the end.\n\n## Evidence\n${
  Array.from({ length: 9 }, (_, i) => `- Request ${i + 1} returned an empty page with a next cursor`).join("\n")}`;

export const Hypothesis: StoryObj = { render: () => <CheckpointDocument path="hypothesis.md" content={HYPOTHESIS} /> };
export const Plan: StoryObj = { render: () => <CheckpointDocument path="plan.md" content={PLAN} /> };
export const OneLine: StoryObj = { render: () => <CheckpointDocument path="plan.md" content="Guard the empty cart in total()." /> };
export const LongPart: StoryObj = { render: () => <CheckpointDocument path="hypothesis.md" content={LONG} /> };
export const Narrow: StoryObj = {
  render: () => <div style={{ maxWidth: 340 }}><CheckpointDocument path="plan.md" content={PLAN} /></div>,
};
