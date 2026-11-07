import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpendChart } from "./SpendChart.tsx";
import { emptyTotals } from "../lib/usage.ts";
import { usage14, usage7 } from "../storybook/data.ts";

const meta = { title: "Usage/SpendChart", component: SpendChart } satisfies Meta<typeof SpendChart>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FourteenDays: Story = { args: { days: usage14.byDay } };
export const SevenDays: Story = { args: { days: usage7.byDay } };
export const Dark: Story = { args: { days: usage14.byDay }, parameters: { theme: "dark" } };
export const NoSpend: Story = { args: { days: usage7.byDay.map((d) => ({ key: d.key, totals: emptyTotals() })) } };
/** Every day has unpriced work: the rings show it even though the bars are low. */
export const MostlyUnknown: Story = {
  args: { days: usage7.byDay.map((d, i) => ({ key: d.key, totals: { ...d.totals, costMicrousd: i * 10_000, unknownCost: 4 + i } })) },
};
export const Mobile: Story = { args: { days: usage14.byDay }, globals: { viewport: { value: "phone" } } };
