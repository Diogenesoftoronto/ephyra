import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommandMenu } from "./CommandMenu.tsx";
const meta = { title: "Console/CommandMenu", component: CommandMenu, args: { onNavigate: () => {} } } satisfies Meta<
  typeof CommandMenu
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Dark: Story = {
  decorators: [
    (Story) => (
      <div data-theme="dark">
        <Story />
      </div>
    ),
  ],
};
