import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkingIndicator } from "./WorkingIndicator.tsx";
const meta: Meta = { title: "Components/WorkingIndicator" };
export default meta;
export const Working: StoryObj = { render: () => <WorkingIndicator /> };
export const Dark: StoryObj = { parameters: { theme: "dark" }, render: () => <WorkingIndicator /> };
