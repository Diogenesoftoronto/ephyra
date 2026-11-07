import type { Meta, StoryObj } from "@storybook/react-vite";
import { WarningList } from "./WarningList.tsx";

const meta: Meta = { title: "Components/WarningList" };
export default meta;
export const Default: StoryObj = {
  render: () => <WarningList warnings={["error: invalid mode", "line 4: unknown key ignored"]} />,
};
export const Clean: StoryObj = { render: () => <WarningList warnings={[]} /> };
