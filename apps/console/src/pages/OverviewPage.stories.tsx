import type { Meta, StoryObj } from "@storybook/react-vite";
import { OverviewPage } from "./OverviewPage.tsx";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Screens/OverviewPage" };
export default meta;
export const Default: StoryObj = { render: () => <OverviewPage /> };
export const Dark: StoryObj = { ...Default, parameters: { theme: "dark" } };
export const Empty: StoryObj = { ...Default, parameters: { fake: { empty: true } } };
export const Loading: StoryObj = {
  ...Default,
  parameters: { fake: { hang: ["inbox", "activity", "usage", "runs"] } },
};
export const Unavailable: StoryObj = {
  ...Default,
  parameters: {
    fake: {
      fail: {
        inbox: new ApiError(503),
        activity: new ApiError(503),
        usage: new ApiError(503),
        runs: new ApiError(503),
        personas: new ApiError(503),
        doc: new ApiError(503),
      },
    },
  },
};
export const PartialFailure: StoryObj = {
  ...Default,
  parameters: { fake: { fail: { usage: new ApiError(503) } } },
};
