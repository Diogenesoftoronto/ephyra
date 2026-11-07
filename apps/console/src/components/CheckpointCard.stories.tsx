import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckpointCard } from "./CheckpointCard.tsx";
import { inbox } from "../storybook/data.ts";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Components/CheckpointCard" };
export default meta;
export const Default: StoryObj = {
  render: () => <CheckpointCard checkpoint="C" item={inbox[0]} onDecide={async () => undefined} />,
};
export const Stale: StoryObj = {
  render: () => <CheckpointCard checkpoint="C" item={inbox[0]} stale="Revision changed from 9 to 10." />,
};
export const ReadOnly: StoryObj = {
  render: () => <CheckpointCard checkpoint="C" item={inbox[0]} canDecide={false} />,
};
export const ConflictOnApprove: StoryObj = {
  render: () => (
    <CheckpointCard
      checkpoint="C"
      item={inbox[0]}
      onDecide={async () => {
        throw new ApiError(409);
      }}
    />
  ),
};
