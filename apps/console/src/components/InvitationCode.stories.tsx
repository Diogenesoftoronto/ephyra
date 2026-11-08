import type { Meta, StoryObj } from "@storybook/react-vite";
import { InvitationCode } from "./InvitationCode.tsx";

const meta: Meta<typeof InvitationCode> = {
  title: "Team/InvitationCode", component: InvitationCode,
  args: { url: "https://ephyra.example/app/#/join/fictional-storybook-invitation-not-redeemable", role: "viewer" },
};
export default meta;
type Story = StoryObj<typeof InvitationCode>;
export const Viewer: Story = {};
export const Approver: Story = { args: { role: "approver" } };
export const Dark: Story = { parameters: { theme: "dark" } };
