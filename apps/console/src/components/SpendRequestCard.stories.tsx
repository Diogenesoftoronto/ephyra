import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpendRequestCard } from "./SpendRequestCard.tsx";

const meta: Meta = { title: "Components/SpendRequestCard" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <SpendRequestCard
      purpose="Recorded request for a refund-screen study"
      microusd={2500000}
      onDecide={async () => undefined}
    />
  ),
};
export const ReadOnly: StoryObj = {
  render: () => <SpendRequestCard purpose="Refund-screen study" microusd={2500000} canDecide={false} />,
};
