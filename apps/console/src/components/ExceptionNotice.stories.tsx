import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExceptionNotice } from "./ExceptionNotice.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/ExceptionNotice" };
export default meta;
export const Default: StoryObj = { render: () => <ExceptionNotice runs={runs.map((b) => b.run)} /> };
