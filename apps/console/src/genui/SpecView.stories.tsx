import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpecView } from "./SpecView.tsx";
import { areaFormSpec, INVALID_SPECS } from "../fake/specs.ts";
import { readAreaForm } from "../fake/autonomy.ts";
import { formArea } from "../storybook/data.ts";
const host = { apply: async () => undefined, ask: () => undefined, discard: () => undefined };

const meta: Meta = { title: "Components/SpecView" };
export default meta;
export const AreaForm: StoryObj = { render: () => <SpecView spec={areaFormSpec(formArea)} host={host} /> };
export const Invalid: StoryObj = {
  render: () => <SpecView spec={INVALID_SPECS["unknown component"]} host={host} />,
};
export const ReadOnly: StoryObj = {
  render: () => <SpecView spec={areaFormSpec(formArea)} host={host} disabled />,
};
