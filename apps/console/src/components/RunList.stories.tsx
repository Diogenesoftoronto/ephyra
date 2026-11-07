import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunList } from "./RunList.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/RunList" };
export default meta;
export const Default: StoryObj = { render: () => <RunList runs={runs.map((b) => b.run)} /> };
export const Empty: StoryObj = { render: () => <RunList runs={[]} /> };
