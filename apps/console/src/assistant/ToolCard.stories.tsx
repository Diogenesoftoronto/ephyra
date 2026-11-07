import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunThread } from "./RunThread.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/ToolCard" };
export default meta;
export const InTranscript: StoryObj = {
  render: () => <RunThread run={runs[0]!.run} events={runs[0]!.events} />,
};
