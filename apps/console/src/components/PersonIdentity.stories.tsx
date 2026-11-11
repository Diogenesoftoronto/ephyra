import type { Meta, StoryObj } from "@storybook/react-vite";
import { PersonIdentity } from "./PersonIdentity.tsx";

const meta: Meta<typeof PersonIdentity> = { title: "Account/PersonIdentity", component: PersonIdentity };
export default meta;
type Story = StoryObj<typeof PersonIdentity>;
const did = "did:plc:storybook-viewer";
export const Verified: Story = {
  args: {
    did,
    profile: {
      did,
      status: "verified",
      handle: "viewer.fixture.test",
      displayName: "Sam (fixture)",
      avatar: false,
      checkedAt: "2026-11-07T14:00:00Z",
    },
  },
};
export const HandleOnly: Story = {
  args: {
    did,
    profile: {
      did,
      status: "verified",
      handle: "viewer.fixture.test",
      displayName: null,
      avatar: false,
      checkedAt: null,
    },
  },
};
export const Loading: Story = { args: { did, loading: true } };
export const InvitationLabelOnly: Story = {
  args: {
    did,
    invitedAs: "Release partner",
    profile: { did, status: "unavailable", handle: null, displayName: null, avatar: false, checkedAt: null },
  },
};
export const Unavailable: Story = { args: { did, profile: null } };
export const BrokenAvatar: Story = {
  args: {
    did,
    avatarUrl: "/app/does-not-exist.png",
    profile: {
      did,
      status: "verified",
      handle: "viewer.fixture.test",
      displayName: "Sam (fixture)",
      avatar: true,
      checkedAt: null,
    },
  },
};
