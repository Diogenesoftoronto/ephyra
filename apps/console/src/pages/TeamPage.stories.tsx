import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { ApiError } from "../api.ts";
import { EMPTY_TEAM_FIXTURE, FakeTeamApi, TEAM_FIXTURE, type FakeTeamOptions } from "../fake/team.ts";
import { TeamPage } from "./TeamPage.tsx";

const meta: Meta = { title: "Account/Team" };
export default meta;

function Fixture({ options = {} }: { options?: FakeTeamOptions }) {
  const [api] = useState(() => new FakeTeamApi(options));
  return <><p className="team-note">Storybook fixture. These people and invitations are fictional; no link grants real access.</p><TeamPage api={api} /></>;
}

async function createLink({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const label = await canvas.findByRole("textbox", { name: "Invitation label" });
  await userEvent.type(label, "Sam · release review");
  await userEvent.click(canvas.getByRole("radio", { name: /Approver/ }));
  await userEvent.click(canvas.getByRole("button", { name: "Create invitation link" }));
}

export const Team: StoryObj = { render: () => <Fixture /> };
export const NoTeammates: StoryObj = { render: () => <Fixture options={{ initial: EMPTY_TEAM_FIXTURE }} /> };
export const Loading: StoryObj = { render: () => <Fixture options={{ hang: ["team"] }} /> };
export const Error: StoryObj = { render: () => <Fixture options={{ fail: { team: new ApiError(503) } }} /> };
export const OwnerOnly: StoryObj = { render: () => <Fixture options={{ fail: { team: new ApiError(403) } }} /> };
export const LinkReady: StoryObj = { render: () => <Fixture />, play: createLink };
export const LiveExpiry: StoryObj = { ...LinkReady, parameters: { clock: null } };
export const CreatingLink: StoryObj = { render: () => <Fixture options={{ hang: ["invite"] }} />, play: createLink };
export const SaveFailed: StoryObj = {
  render: () => <Fixture options={{ fail: { invite: new ApiError(422, "The invitation could not be created.") } }} />,
  play: createLink,
};
export const Uncertain: StoryObj = { render: () => <Fixture options={{ uncertainAfterSave: ["invite"] }} />, play: createLink };
export const RevokeConfirmation: StoryObj = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const remove = await within(canvasElement).findByRole("button", { name: "Remove access for Product review" });
    await userEvent.click(remove);
  },
};
export const Revoked: StoryObj = {
  render: () => <Fixture options={{
    initial: { ...TEAM_FIXTURE, invitations: TEAM_FIXTURE.invitations.map((row) => ({ ...row, revokedAt: "2026-11-08T13:00:00.000Z" })) },
  }} />,
};
export const Narrow: StoryObj = { ...LinkReady, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { render: () => <Fixture />, parameters: { theme: "dark" } };
