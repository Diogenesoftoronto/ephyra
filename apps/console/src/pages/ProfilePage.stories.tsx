import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiProvider } from "../app/ApiContext.tsx";
import { FakeApi } from "../fake/api.ts";
import { ProfilePage } from "./ProfilePage.tsx";

const meta: Meta = { title: "Pages/Your account" };
export default meta;
const page = (api: FakeApi, extra: Partial<Parameters<typeof ProfilePage>[0]> = {}) => (
  <ApiProvider api={api}><ProfilePage principal="did:web:alex.example" onDisconnect={() => {}} {...extra} /></ApiProvider>
);
export const Verified: StoryObj = { render: () => page(new FakeApi({ profiles: "fixture" })) };
export const SharedViewerWorkspace: StoryObj = { render: () => page(new FakeApi({ profiles: "fixture" }), { workspaceName: "Observatory", workspaceRole: "viewer" }) };
export const NotOrganicUnavailable: StoryObj = { render: () => page(new FakeApi({ profiles: "unavailable" })) };
export const Loading: StoryObj = { render: () => page(new FakeApi({ profiles: "hang" })) };
export const ReadFailed: StoryObj = { render: () => page(new FakeApi({ fail: { profile: new Error("offline") } })) };
