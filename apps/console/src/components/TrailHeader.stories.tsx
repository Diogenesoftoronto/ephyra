import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrailHeader } from "./TrailHeader.tsx";
import { trailByShort } from "../storybook/data.ts";
const meta: Meta = { title: "Components/TrailHeader" };
export default meta;
export const Default: StoryObj = { render: () => <TrailHeader trail={trailByShort("c2d018")} /> };
