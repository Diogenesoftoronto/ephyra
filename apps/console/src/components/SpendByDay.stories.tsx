import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpendByDay } from "./SpendByDay.tsx";
import { usage7 } from "../storybook/data.ts";
const meta: Meta = { title: "Components/SpendByDay" };
export default meta;
export const Default: StoryObj = { render: () => <SpendByDay days={usage7.byDay} /> };
export const Empty: StoryObj = { render: () => <SpendByDay days={[]} partial={false} /> };
