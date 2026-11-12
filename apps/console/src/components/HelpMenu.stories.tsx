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
/** One dismissible toast per visit. All tips remain in Help, which can also turn them off. */
export const Tip: StoryObj = {
  beforeEach: () => {
    localStorage.removeItem("ephyra.tips.off");
    localStorage.removeItem("ephyra.tips.dismissed");
  },
  render: () => <PageTip page="usage" />,
  play: async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); },
};
export const TipDark: StoryObj = { ...Tip, parameters: { theme: "dark" } };
export const TipPhone: StoryObj = { ...Tip, globals: { viewport: { value: "phone" } } };
