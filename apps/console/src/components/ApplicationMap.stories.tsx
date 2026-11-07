import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApplicationMap } from "./ApplicationMap.tsx";
import { useState } from "react";
import { sketches } from "../storybook/data.ts";
const meta: Meta = { title: "Components/ApplicationMap" };
export default meta;
export const Default: StoryObj = { render: () => <ApplicationMap sketches={sketches} /> };
export const Editing: StoryObj = {
  render: function Editing() {
    const [value, setValue] = useState(sketches);
    return <ApplicationMap sketches={value} original={sketches} onChange={setValue} />;
  },
};
export const Empty: StoryObj = { render: () => <ApplicationMap sketches={[]} /> };
