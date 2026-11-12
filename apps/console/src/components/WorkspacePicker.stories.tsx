import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkspaceAccess } from "@ephyra/core";
import { userEvent, within } from "storybook/test";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

const meta: Meta = { title: "Account/Workspace picker" };
export default meta;

/** Fictional workspaces; choosing one only changes local story state. */
const WORKSPACES: WorkspaceAccess[] = [
  { workspaceId: "own", ownerDid: "did:plc:storybook-owner", name: "checkout-service", role: "owner" },
  { workspaceId: "shared", ownerDid: "did:plc:storybook-inviter", name: "Observatory", role: "approver" },
  { workspaceId: "long", ownerDid: "did:plc:storybook-other", name: "A workspace with a long name that has to truncate", role: "viewer" },
];
function Picker() {
  const [selected, setSelected] = useState("own");
  return <WorkspacePicker workspaces={WORKSPACES} selected={selected} onChoose={setSelected} />;
}
export const Closed: StoryObj = { render: () => <Picker /> };
export const Open: StoryObj = {
  render: () => <Picker />,
  play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: /Workspace:/ })); },
};
