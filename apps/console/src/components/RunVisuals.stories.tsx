import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { runs } from "../storybook/data.ts";
import { demoRunVisual } from "../fake/run-visual.ts";
import { RunVisuals } from "./RunVisuals.tsx";
const meta: Meta = { title: "Components/RunVisuals" };
export default meta;
const run = runs[0]!.run;
const event = { runId: run.id, seq: 100, at: run.startedAt, type: "message" as const, visual: demoRunVisual };
export const Shared: StoryObj = { render: () => <RunVisuals run={run} events={[event]} /> };
export const Empty: StoryObj = { render: () => <RunVisuals run={{ ...run, executor: { kind: "local" } }} events={[]} /> };
export const Dark: StoryObj = { ...Shared, parameters: { theme: "dark" } };
function UpdateExample() {
  const [updated, setUpdated] = useState(false);
  return <><button type="button" onClick={() => setUpdated(true)}>Simulate a new visual revision</button>
    <RunVisuals run={run} events={[event, ...(updated ? [{ ...event, seq: 101,
      visual: { ...demoRunVisual, html: demoRunVisual.html.replace("One rounding step.", "Updated explanation.") } }] : [])]} /></>;
}
export const Updated: StoryObj = { render: () => <UpdateExample /> };
