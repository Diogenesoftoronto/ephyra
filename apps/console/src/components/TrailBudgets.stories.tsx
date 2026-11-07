import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrailBudgets } from "./TrailBudgets.tsx";
import { usage14 } from "../storybook/data.ts";

const meta = { title: "Usage/TrailBudgets", component: TrailBudgets } satisfies Meta<typeof TrailBudgets>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Budgets: Story = { args: { trails: usage14.byTrail } };
export const NearLimit: Story = {
  args: { trails: usage14.byTrail.map((t) => ({ ...t, budget: { ...t.budget, spendMicrousdUsed: t.budget.spendMicrousdMax * 0.96 } })) },
};
export const Empty: Story = { args: { trails: [] } };
