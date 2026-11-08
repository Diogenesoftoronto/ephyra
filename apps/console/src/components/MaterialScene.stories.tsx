import type { Meta, StoryObj } from "@storybook/react-vite";
import { MaterialScene } from "./MaterialScene.tsx";
const meta: Meta = { title: "Components/MaterialScene" };
export default meta;
export const Default: StoryObj = { render: () => (
  <div style={{ maxWidth: 480 }}><MaterialScene title="From signal to proof."
    description="Follow the investigation. See the evidence. Decide where Ephyra can act." /></div>
) };
export const Compact: StoryObj = { render: () => (
  <div style={{ maxWidth: 360 }}><MaterialScene compact title="A good place to begin."
    description="One repository, a clear policy, and a record of every step." /></div>
) };
