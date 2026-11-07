import { ME } from "../fake/fixtures.ts";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrailPanel } from "./TrailPanel.tsx";
import { inbox, trailId } from "../storybook/data.ts";
const meta: Meta = { title: "Screens/TrailPanel" };
export default meta;
export const Default: StoryObj = { render: () => <TrailPanel principal={ME} trailId={trailId("c2d018")} items={inbox} /> };
