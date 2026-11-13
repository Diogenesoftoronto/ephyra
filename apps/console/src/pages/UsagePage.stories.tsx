import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsagePage } from "./UsagePage.tsx";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Screens/UsagePage" };
export default meta;
export const Default: StoryObj = { render: () => <UsagePage />, parameters: { fake: { questHistory: true } } };
export const Narrow: StoryObj = { ...Default, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Default, parameters: { theme: "dark", fake: { questHistory: true } } };
export const Empty: StoryObj = { ...Default, parameters: { fake: { empty: true } } };
export const Loading: StoryObj = {
  ...Default,
  parameters: { fake: { hang: ["activity", "usage", "trails", "runs", "personas", "doc", "docs", "drafts"] } },
};
export const Unavailable: StoryObj = {
  ...Default,
  parameters: {
    fake: {
      fail: {
        activity: new ApiError(503),
        usage: new ApiError(503),
        trails: new ApiError(503),
        runs: new ApiError(503),
        personas: new ApiError(503),
        doc: new ApiError(503),
      },
    },
  },
};
