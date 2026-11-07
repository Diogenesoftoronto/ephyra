import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunHeader } from "./RunHeader.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/RunHeader" };
export default meta;
export const Default: StoryObj = { render: () => <RunHeader run={runs[0]!.run} stream="live" /> };
export const Delayed: StoryObj = { render: () => <RunHeader run={runs[0]!.run} stream="reconnecting" /> };
