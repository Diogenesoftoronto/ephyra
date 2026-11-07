import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrailActions } from "./TrailActions.tsx";

const meta: Meta = { title: "Components/TrailActions" };
export default meta;
export const Default: StoryObj = {
  render: () => <TrailActions owned={false} parked={false} onAct={async () => undefined} />,
};
export const ReadOnly: StoryObj = {
  render: () => <TrailActions owned={false} parked={false} canAct={false} onAct={async () => undefined} />,
};
