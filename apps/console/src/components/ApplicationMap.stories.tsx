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
/** A draft that changed one area, added one and removed one, compared with the policy in effect. */
export const Changed: StoryObj = {
  render: function Changed() {
    const [value, setValue] = useState([
      { ...sketches[0]!, level: sketches[0]!.level === "patch" ? ("propose" as const) : ("patch" as const) },
      ...sketches.slice(1, -1),
      { name: "billing", intent: "Invoices and plans.", paths: ["src/billing/**", "src/invoices/**"], risk: "high" as const,
        level: "propose" as const, userFacing: true },
    ]);
    return <ApplicationMap sketches={value} original={sketches} onChange={setValue} />;
  },
};
/** The narrow draft column and phones: rows fold instead of scrolling sideways. */
export const Narrow: StoryObj = {
  render: () => <div style={{ maxWidth: 340 }}><ApplicationMap sketches={sketches} /></div>,
};
export const Empty: StoryObj = { render: () => <ApplicationMap sketches={[]} /> };
