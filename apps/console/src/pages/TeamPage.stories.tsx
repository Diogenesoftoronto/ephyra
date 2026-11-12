import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { ApiError } from "../api.ts";
import { EMPTY_TEAM_FIXTURE, FakeTeamApi, TEAM_FIXTURE, type FakeTeamOptions } from "../fake/team.ts";
import type { PeopleConnection } from "@ephyra/core";
import { BRIDGE_QUESTION_FIXTURE, CONNECTION_ACCOUNT_FIXTURE, QUESTION_FIXTURE } from "../fake/connections.ts";
import { ME, STORY_NOW } from "../fake/fixtures.ts";
import { TeamPage } from "./TeamPage.tsx";

const meta: Meta = { title: "Account/Team" };
export default meta;

function Fixture({ options = {}, tab = "access", channels, member }: {
  options?: FakeTeamOptions; tab?: string; channels?: PeopleConnection | null; member?: boolean;
}) {
  const [api] = useState(() => new FakeTeamApi(options));
  return <><p className="team-note">
    Storybook fixture. These people, questions, and invitations are fictional; no link grants real access and nothing is delivered.
  </p>
    <TeamPage api={member ? undefined : api} tab={tab} channels={channels} /></>;
}
const ROSTER = { initial: { ...TEAM_FIXTURE, ownerDid: ME } };
/** The owner's own question, asked an hour before the story clock, and one sent to a bridge contact. */
const ASKING = { fake: { questions: [
  { ...QUESTION_FIXTURE, recipient: { ...QUESTION_FIXTURE.recipient!, did: ME }, createdAt: new Date(STORY_NOW - 3_600_000).toISOString() },
  BRIDGE_QUESTION_FIXTURE,
] } };

async function createLink({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const label = await canvas.findByRole("textbox", { name: "Invitation label" });
  await userEvent.type(label, "Sam · release review");
  await userEvent.click(canvas.getByRole("radio", { name: /Approver/ }));
  await userEvent.click(canvas.getByRole("button", { name: "Create invitation link" }));
}

export const Now: StoryObj = {
  render: () => <Fixture tab="now" options={ROSTER} channels={CONNECTION_ACCOUNT_FIXTURE.people} />, parameters: ASKING,
};
export const NowWhyAPerson: StoryObj = {
  ...Now,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Ephyra is asking");
    const summaries = [...canvasElement.querySelectorAll<HTMLElement>(".space-why summary")];
    for (const label of ["Checkout returns", "may a discount"])
      await userEvent.click(summaries.find((el) => el.textContent?.includes(label))!);
  },
};
export const NowNoBridge: StoryObj = { render: () => <Fixture tab="now" options={ROSTER} channels={null} />, parameters: ASKING };
export const NowNothingWaiting: StoryObj = { render: () => <Fixture tab="now" options={ROSTER} channels={null} />, parameters: { fake: { empty: true } } };
export const NowAsMember: StoryObj = { render: () => <Fixture tab="now" member />, parameters: ASKING };
export const NowNarrow: StoryObj = { ...Now, globals: { viewport: { value: "phone" } } };
export const NowDark: StoryObj = { ...Now, parameters: { ...ASKING, theme: "dark" } };
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
