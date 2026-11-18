import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkspacePage } from "./WorkspacePage.tsx";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
const meta: Meta = { title: "Screens/WorkspacePage" };
export default meta;
/** The seeded workspace has an open draft of autonomy.md, so the policy is read-only with "Continue the draft". */
export const Default: StoryObj = { render: () => <WorkspacePage /> };
/** No open draft of the policy: the board and the raw document are edited in place. */
export const Editable: StoryObj = { ...Default, parameters: { fake: { autonomyDraftOpen: false } } };
export const EditableDark: StoryObj = { ...Editable, parameters: { ...Editable.parameters, theme: "dark" } };
export const ReadOnlyRole: StoryObj = {
  render: () => <WorkspacePage canDraft={false} />,
  parameters: { fake: { autonomyDraftOpen: false, approver: false } },
};
/** The draft is created, then saving the edits into it has an unknown outcome: the edits stay and nothing is called saved. */
export const SaveOutcomeUnknown: StoryObj = {
  ...Editable,
  parameters: {
    fake: { autonomyDraftOpen: false, fail: { updateSketches: new UnknownWriteOutcome("story"), updateContent: new UnknownWriteOutcome("story") } },
  },
};
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
