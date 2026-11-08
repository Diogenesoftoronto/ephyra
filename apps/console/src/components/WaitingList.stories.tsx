import type { Meta, StoryObj } from "@storybook/react-vite";
import { WaitingList } from "./WaitingList.tsx";
import { inbox } from "../storybook/data.ts";

const meta = { title: "Activity/WaitingList", component: WaitingList } satisfies Meta<typeof WaitingList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = { args: { items: inbox } };
export const Truncated: Story = { args: { items: inbox, limit: 2 } };
export const Nothing: Story = { args: { items: inbox.filter((i) => i.kind === "parked") } };
export const LongTitles: Story = {
  args: { items: inbox.map((item) => ({
    ...item,
    title: "Webhook retries charge a customer twice when the payment provider times out during subscription renewal",
    area: "subscription-payments-and-invoicing",
  })) },
};
