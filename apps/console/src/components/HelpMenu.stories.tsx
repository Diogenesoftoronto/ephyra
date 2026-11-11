import type { Meta, StoryObj } from "@storybook/react-vite";
import { HelpMenu, PageTip } from "./HelpMenu.tsx";
import { agentBrief } from "../lib/help.ts";

const brief = () => agentBrief({ server: "https://console.example", repository: "https://git.example/team/app.git", branch: "main", page: "inbox" });
const meta = { title: "Console/HelpMenu", component: HelpMenu, args: { page: "inbox", brief } } satisfies Meta<typeof HelpMenu>;
export default meta;
type Story = StoryObj<typeof meta>;
const open = async ({ canvasElement }: { canvasElement: HTMLElement }) =>
  canvasElement.querySelector<HTMLButtonElement>(".help-menu__trigger")?.click();

export const Closed: Story = {};
export const Open: Story = { play: open };
export const WorkspaceHelp: Story = { args: { page: "workspace" }, play: open };
export const Dark: Story = { parameters: { theme: "dark" }, play: open };
export const Phone: Story = { globals: { viewport: { value: "phone" } }, play: open };
/** The one-line tip above a screen. "Got it" shows the next one; the help menu can turn them off. */
export const Tip: StoryObj = { render: () => <PageTip page="usage" /> };
