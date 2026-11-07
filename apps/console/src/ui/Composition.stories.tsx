import type { Meta, StoryObj } from "@storybook/react-vite";
import { App } from "../app/App.tsx";
import { useApi } from "../app/ApiContext.tsx";
const meta: Meta = { title: "UI/Composition", parameters: { layout: "fullscreen" } };
export default meta;
export const OverviewInShell: StoryObj = {
  render: function Composition() {
    return <App api={useApi()} demo />;
  },
};
