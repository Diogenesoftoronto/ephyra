import type { Meta, StoryObj } from "@storybook/react-vite";
import { MapDiff } from "./MapDiff.tsx";
import { sketches } from "../storybook/data.ts";
const meta: Meta = { title: "Components/MapDiff" };
export default meta;
export const Default: StoryObj = {
  render: () => <MapDiff before={sketches} after={sketches.map((s) => ({ ...s, level: "watch" }))} />,
};
