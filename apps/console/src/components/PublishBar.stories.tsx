import type { Meta, StoryObj } from "@storybook/react-vite";
import { PublishBar } from "./PublishBar.tsx";
import { draft } from "../storybook/data.ts";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Components/PublishBar" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <PublishBar draft={draft} onPublish={async () => undefined} onDiscard={async () => undefined} />
  ),
};
export const Conflict: StoryObj = {
  render: () => (
    <PublishBar
      draft={draft}
      onPublish={async () => {
        throw new ApiError(409);
      }}
      onDiscard={async () => undefined}
    />
  ),
};
export const ReadOnly: StoryObj = {
  render: () => (
    <PublishBar
      draft={draft}
      canPublish={false}
      onPublish={async () => undefined}
      onDiscard={async () => undefined}
    />
  ),
};
