import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrailTimeline } from "./TrailTimeline.tsx";
import { eventsFor } from "../storybook/data.ts";
const meta: Meta = { title: "Components/TrailTimeline" };
export default meta;
export const Default: StoryObj = { render: () => <TrailTimeline events={eventsFor("c2d018")} /> };
