import type { Meta, StoryObj } from "@storybook/react-vite";
import { FakeApi } from "../fake/api.ts";
import { VelumProvider } from "../velum/VelumProvider.tsx";
import { CompanionPanel } from "../velum/CompanionPanel.tsx";
import { ApplicationMap } from "./ApplicationMap.tsx";
import { WorkspaceAsk } from "./WorkspaceAsk.tsx";

const meta: Meta = { title: "Velum/Workspace ask" };
export default meta;
const sketches = [
  { name: "payments", intent: "Checkout and refunds.", paths: ["src/payments/**"], risk: "critical" as const, level: "propose" as const, userFacing: true },
  { name: "cart", intent: "The basket and coupons.", paths: ["src/cart/**"], risk: "medium" as const, level: "patch" as const, userFacing: true },
];
const frame = (canDraft: boolean, failure: { title: string; body: string } | null = null, canSpend = true) => (
  <VelumProvider api={new FakeApi({ conversation: "fixture" })} scope="story" context={{ kind: "overview" }} contextLabel="Workspace" canSpend={canSpend}>
    <ApplicationMap sketches={sketches} revision="fixture-digest" />
    <WorkspaceAsk canDraft={canDraft} busy={false} failure={failure} onDraft={async () => {}} />
    <CompanionPanel />
  </VelumProvider>
);
export const Approver: StoryObj = { render: () => frame(true) };
export const Viewer: StoryObj = { render: () => frame(false, null, false) };
export const DraftFailed: StoryObj = { render: () => frame(true, { title: "This is not available right now", body: "The service did not answer. Nothing was changed." }) };
