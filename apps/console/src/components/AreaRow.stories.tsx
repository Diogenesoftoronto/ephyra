import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AreaRow, LevelMeter, RemovedAreaRow } from "./AreaRow.tsx";
import { AUTONOMY_LEVELS } from "@ephyra/core";
import { sketches } from "../storybook/data.ts";
const meta: Meta = { title: "Components/AreaRow" };
export default meta;
const area = sketches[0]!;
const Board = ({ children }: { children: React.ReactNode }) => (
  <div className="map"><div className="map-rows">{children}</div></div>
);
export const Closed: StoryObj = {
  render: () => <Board><AreaRow sketch={area} open={false} onToggle={() => undefined} /></Board>,
};
export const Open: StoryObj = {
  render: () => <Board><AreaRow sketch={area} open onToggle={() => undefined} /></Board>,
};
export const Editing: StoryObj = {
  render: function Editing() {
    const [value, setValue] = useState(area);
    const [open, setOpen] = useState(true);
    return (
      <Board>
        <AreaRow sketch={value} original={area} open={open} onToggle={() => setOpen(!open)} onChange={setValue}
          onRemove={() => undefined} />
      </Board>
    );
  },
};
export const NewAndRemoved: StoryObj = {
  render: () => (
    <Board>
      <AreaRow sketch={{ ...area, name: "billing" }} original={null} open={false} onToggle={() => undefined} />
      <RemovedAreaRow sketch={area} onRestore={() => undefined} />
    </Board>
  ),
};
export const Meter: StoryObj = {
  render: () => (
    <div className="stack">
      {AUTONOMY_LEVELS.map((l) => <LevelMeter key={l.id} level={l.id} />)}
      <LevelMeter level="auto" risk="critical" />
    </div>
  ),
};
