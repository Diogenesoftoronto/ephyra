import type { Meta, StoryObj } from "@storybook/react-vite";
import { runs } from "../storybook/data.ts";
import { RunAccess } from "./RunAccess.tsx";
const meta: Meta = { title: "Components/RunAccess" };
export default meta;
export const Orb: StoryObj = { render: () => <RunAccess run={runs[0]!.run} /> };
export const Compact: StoryObj = { render: () => <RunAccess run={runs[0]!.run} compact /> };
export const MissingLink: StoryObj = { render: () => <RunAccess run={{ ...runs[0]!.run, executor: { kind: "orb" } }} /> };
