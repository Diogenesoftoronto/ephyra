import type { Meta, StoryObj } from "@storybook/react-vite";
import { AmbientMaterial } from "./AmbientMaterial.tsx";
const meta: Meta<typeof AmbientMaterial> = {
  title: "Motion/AmbientMaterial", component: AmbientMaterial,
  args: { base: "/app/materials/experiments/kling-living-glass" },
  decorators: [(Story) => <div style={{ position: "relative", isolation: "isolate", height: 400, maxWidth: 600, background: "#142a28" }}>
    <Story />
  </div>],
};
export default meta;
type Story = StoryObj<typeof AmbientMaterial>;
export const Entrance: Story = {};
export const WanComparison: Story = { args: { base: "/app/materials/experiments/wan-honey-caustics" } };
export const EarlierKlingBrief: Story = { args: { base: "/app/materials/experiments/kling-honey-caustics" } };
export const MissingMovie: Story = { args: { base: "/app/materials/experiments/missing" } };
