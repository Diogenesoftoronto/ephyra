import type { Meta, StoryObj } from "@storybook/react-vite";
import { Cost, TotalCost } from "./Cost.tsx";

const meta = { title: "Usage/Cost", component: Cost } satisfies Meta<typeof Cost>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Known: Story = { args: { micro: 4_200_000 } };
export const Free: Story = { args: { micro: 0 } };
export const Tiny: Story = { args: { micro: 3_500 } };
/** Unknown reads "unknown". It is never shown as $0. */
export const Unknown: Story = { args: { micro: null } };
export const Totals: Story = {
  args: { micro: null },
  render: () => (
    <div className="stack-sm">
      <TotalCost totals={{ costMicrousd: 12_340_000, unknownCost: 0 }} />
      <TotalCost totals={{ costMicrousd: 12_340_000, unknownCost: 3 }} />
      <TotalCost totals={{ costMicrousd: 0, unknownCost: 5 }} />
    </div>
  ),
};
