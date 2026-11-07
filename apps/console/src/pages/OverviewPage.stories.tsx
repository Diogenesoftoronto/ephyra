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
  parameters: { fake: { hang: ["activity", "usage", "runs", "personas", "doc", "docs", "drafts"] } },
};
export const Unavailable: StoryObj = {
  ...Default,
  parameters: {
    fake: {
      fail: {
        activity: new ApiError(503),
        usage: new ApiError(503),
        runs: new ApiError(503),
        personas: new ApiError(503),
        doc: new ApiError(503),
      },
    },
  },
};
