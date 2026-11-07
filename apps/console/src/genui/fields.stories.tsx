import type { Meta, StoryObj } from "@storybook/react-vite";
import { SpecView } from "./SpecView.tsx";
import { areaFormSpec, checkpointFormSpec } from "../fake/specs.ts";
import { readAreaForm } from "../fake/autonomy.ts";
import { formArea } from "../storybook/data.ts";
const host = { apply: async () => undefined, ask: () => undefined, discard: () => undefined };

const meta: Meta = { title: "Components/fields" };
export default meta;
export const AreaFields: StoryObj = {
  render: () => <SpecView spec={areaFormSpec(formArea, "Example policy form")} host={host} />,
};
export const CheckpointsAndDiff: StoryObj = {
  render: () => (
    <SpecView
      spec={checkpointFormSpec("payments", { A: "blocking", B: "blocking", C: "blocking" })}
      host={host}
    />
  ),
};
