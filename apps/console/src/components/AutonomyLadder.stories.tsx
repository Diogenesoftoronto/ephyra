import type { Meta, StoryObj } from "@storybook/react-vite";
import { AutonomyLadder } from "./AutonomyLadder.tsx";
import { useState } from "react";
import type { AutonomyLevel } from "@ephyra/core";
const meta: Meta = { title: "Components/AutonomyLadder" };
export default meta;
export const Default: StoryObj = { render: () => <AutonomyLadder value="patch" /> };
export const Editing: StoryObj = {
  render: function Editing() {
    const [value, setValue] = useState<AutonomyLevel>("propose");
    return <AutonomyLadder value={value} risk="critical" onChange={setValue} />;
  },
};
