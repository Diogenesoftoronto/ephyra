import type { Meta, StoryObj } from "@storybook/react-vite";
import { WeekSpend } from "./WeekSpend.tsx";
import { usage7 } from "../storybook/data.ts";

const meta = { title: "Usage/WeekSpend", component: WeekSpend } satisfies Meta<typeof WeekSpend>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithUnknown: Story = { args: { usage: usage7 } };
export const NoUnknown: Story = { args: { usage: { ...usage7, totals: { ...usage7.totals, unknownCost: 0 } } } };
export const NearBudget: Story = {
  args: { usage: { ...usage7, totals: { ...usage7.totals, costMicrousd: usage7.byTrail.reduce((n, t) => n + t.budget.spendMicrousdMax, 0) * 0.95 } } },
};
export const NoBudgets: Story = { args: { usage: { ...usage7, byTrail: [] } } };
