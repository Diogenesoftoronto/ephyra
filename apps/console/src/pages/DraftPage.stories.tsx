import type { Meta, StoryObj } from "@storybook/react-vite";
import { DraftPage } from "./DraftPage.tsx";
const meta: Meta = { title: "Screens/DraftPage" };
export default meta;
export const Default: StoryObj = { render: () => <DraftPage draftId="d-1" /> };
export const ReadOnly: StoryObj = { render: () => <DraftPage draftId="d-1" canPublish={false} /> };
export const ModelUnavailable: StoryObj = {
  ...Default,
  parameters: { fake: { seedConversation: false, velumUnavailable: true } },
};
export const PublishConflict: StoryObj = { ...Default, parameters: { fake: { publishConflict: true } } };
export const Published: StoryObj = { render: () => <DraftPage draftId="d-2" /> };
export const Discarded: StoryObj = { render: () => <DraftPage draftId="d-3" /> };
