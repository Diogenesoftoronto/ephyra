import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageStats } from "./UsageStats.tsx";
import { emptyTotals } from "../lib/usage.ts";
import { usage14 } from "../storybook/data.ts";

const meta = { title: "Usage/UsageStats", component: UsageStats } satisfies Meta<typeof UsageStats>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FourteenDays: Story = { args: { totals: usage14.totals } };
export const Empty: Story = { args: { totals: emptyTotals() } };
export const Mobile: Story = { args: { totals: usage14.totals }, globals: { viewport: { value: "phone" } } };
