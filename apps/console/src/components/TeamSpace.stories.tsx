import type { Meta, StoryObj } from "@storybook/react-vite";
import { BRIDGE_QUESTION_FIXTURE, CONNECTION_ACCOUNT_FIXTURE, QUESTION_FIXTURE } from "../fake/connections.ts";
import { TeamSpace } from "./TeamSpace.tsx";

/** Fictional fixtures. No bridge, Slack workspace, or person is contacted. */
const meta: Meta<typeof TeamSpace> = { title: "Team/Space", component: TeamSpace };
export default meta;

const ASKING = { fake: { questions: [QUESTION_FIXTURE, BRIDGE_QUESTION_FIXTURE] } };
export const BridgeConnected: StoryObj<typeof TeamSpace> = { args: { channels: CONNECTION_ACCOUNT_FIXTURE.people }, parameters: ASKING };
export const NoBridge: StoryObj<typeof TeamSpace> = { args: { channels: null }, parameters: ASKING };
export const MemberView: StoryObj<typeof TeamSpace> = { args: {}, parameters: ASKING };
export const Quiet: StoryObj<typeof TeamSpace> = { args: { channels: null }, parameters: { fake: { empty: true } } };
export const FeedsUnavailable: StoryObj<typeof TeamSpace> = {
  args: { channels: null },
  parameters: { fake: { fail: { activity: new Error("fixture: activity offline"), questions: new Error("fixture: questions offline") } } },
};
