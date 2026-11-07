import type { Meta, StoryObj } from "@storybook/react-vite";
import { RunFilters } from "./RunFilters.tsx";
import { noRunFilters } from "./RunFilters.tsx";
import { useState } from "react";
const meta: Meta = { title: "Components/RunFilters" };
export default meta;
export const Default: StoryObj = {
  render: () => <RunFilters value={noRunFilters} trails={[]} onChange={() => undefined} />,
};
