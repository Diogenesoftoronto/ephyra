import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExecutorChip } from "./ExecutorChip.tsx";
import { runs } from "../storybook/data.ts";
const meta: Meta = { title: "Components/ExecutorChip" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <div className="stack">
      {runs.map((b) => (
        <ExecutorChip key={b.run.id} executor={b.run.executor} />
      ))}
    </div>
  ),
};
