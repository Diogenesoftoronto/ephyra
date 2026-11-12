import type { Meta, StoryObj } from "@storybook/react-vite";
import { ME } from "../fake/fixtures.ts";
import { trailId } from "../storybook/data.ts";
import { LoopPage } from "./LoopPage.tsx";

// The stories read the same made-up workspace as every other screen, through the same API the real page polls.
const meta: Meta = { title: "Screens/LoopPage" };
export default meta;
export const Board: StoryObj = { render: () => <LoopPage principal={ME} /> };
export const OpenedOnAQuest: StoryObj = { render: () => <LoopPage principal={ME} questId={trailId("c2d018")} /> };
export const ReadOnly: StoryObj = { render: () => <LoopPage principal={ME} canAct={false} /> };
