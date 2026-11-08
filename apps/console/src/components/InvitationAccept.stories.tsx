import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { ApiError } from "../api.ts";
import { FakeTeamApi, INVITED_WORKSPACE_FIXTURE, type FakeTeamOptions } from "../fake/team.ts";
import { InvitationAccept } from "./InvitationAccept.tsx";

const meta: Meta = { title: "Account/Accept invitation" };
export default meta;
function Fixture({ options = {} }: { options?: FakeTeamOptions }) {
  const [api] = useState(() => new FakeTeamApi(options));
  return <>
    <p className="invitation-note">Storybook fixture. This invitation does not grant real workspace access.</p>
    <InvitationAccept api={api} token="storybook-token-invited-workspace" onAccepted={() => {}} onCancel={() => {}} />
  </>;
}
async function join({ canvasElement }: { canvasElement: HTMLElement }) {
  const button = await within(canvasElement).findByRole("button", { name: "Join workspace" });
  await userEvent.click(button);
}
export const Viewer: StoryObj = { render: () => <Fixture /> };
export const Approver: StoryObj = {
  render: () => <Fixture options={{ acceptedWorkspace: { ...INVITED_WORKSPACE_FIXTURE, role: "approver" } }} />,
};
export const Loading: StoryObj = { render: () => <Fixture options={{ hang: ["preview"] }} /> };
export const Joining: StoryObj = { render: () => <Fixture options={{ hang: ["accept"] }} />, play: join };
export const Joined: StoryObj = { render: () => <Fixture />, play: join };
export const ApproverJoined: StoryObj = { ...Approver, play: join };
export const Expired: StoryObj = { render: () => <Fixture options={{ fail: { preview: new ApiError(410) } }} /> };
export const RevokedAfterOpening: StoryObj = {
  render: () => <Fixture options={{ fail: { accept: new ApiError(410) } }} />,
  play: join,
};
export const Uncertain: StoryObj = { render: () => <Fixture options={{ uncertainAfterSave: ["accept"] }} />, play: join };
export const Dark: StoryObj = { ...Approver, parameters: { theme: "dark" } };
export const Narrow: StoryObj = { ...Approver, globals: { viewport: { value: "phone" } } };
