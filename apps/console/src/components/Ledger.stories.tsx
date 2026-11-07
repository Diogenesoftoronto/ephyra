import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Ledger } from "./Ledger.tsx";
import { usageEntries } from "../storybook/data.ts";

const meta = { title: "Usage/Ledger", component: Ledger } satisfies Meta<typeof Ledger>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Recent: Story = { args: { entries: usageEntries.slice(0, 12) } };
/** Rows with no price read "unknown", and the count above them is separate from the dollar total. */
export const UnknownCost: Story = { args: { entries: usageEntries.filter((e) => e.costMicrousd === null).slice(0, 8) } };
/** Failed and unavailable rows stay visible, with the reason. */
export const FailedAndUnavailable: Story = { args: { entries: usageEntries.filter((e) => e.outcome !== "ok").slice(0, 8) } };
export const Empty: Story = { args: { entries: [] } };
export const LoadMore: Story = {
  args: { entries: [] },
  render: () => {
    const [n, setN] = useState(5);
    return <Ledger entries={usageEntries.slice(0, n)} hasMore={n < 15} onMore={() => setN(n + 5)} />;
  },
};
export const Dark: Story = { args: { entries: usageEntries.slice(0, 8) }, parameters: { theme: "dark" } };
export const Mobile: Story = { args: { entries: usageEntries.slice(0, 6) }, globals: { viewport: { value: "phone" } } };
