import type { Meta, StoryObj } from "@storybook/react-vite";
import { AreaCard } from "./AreaCard.tsx";
import { sketches } from "../storybook/data.ts";
const meta: Meta = { title: "Components/AreaCard" };
export default meta;
export const Default: StoryObj = { render: () => <AreaCard sketch={sketches[0]!} /> };
