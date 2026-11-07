import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PERSONAS } from "@ephyra/core";
import { BreakdownTable } from "./BreakdownTable.tsx";
import { PersonaLabel } from "./PersonaLabel.tsx";
import { Tag } from "../kit.ts";
import { usage14 } from "../storybook/data.ts";

const meta = { title: "Usage/BreakdownTable", component: BreakdownTable } satisfies Meta<typeof BreakdownTable>;
export default meta;
type Story = StoryObj<typeof meta>;

const personaRows = usage14.byPersona.map((g) => ({
  key: g.key ?? "none", totals: g.totals, label: g.key ? <PersonaLabel persona={PERSONAS.find((p) => p.id === g.key)!.id} /> : <PersonaLabel persona={null} />,
}));
const engineRows = usage14.byEngine.map((g) => ({ key: g.key, totals: g.totals, label: <Tag>{g.key}</Tag> }));

export const ByPersona: Story = { args: { title: "By persona", rows: personaRows } };
export const ByEngine: Story = { args: { title: "By engine", rows: engineRows } };
export const Selectable: Story = {
  args: { title: "By persona", rows: personaRows },
  render: (args) => { const [sel, setSel] = useState<string | null>("nema"); return <BreakdownTable {...args} selected={sel} onSelect={setSel} />; },
};
export const Empty: Story = { args: { title: "By engine", rows: [] } };
