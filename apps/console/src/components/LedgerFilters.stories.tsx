import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { LedgerFilters } from "./LedgerFilters.tsx";
import { noFilters, type LedgerFilterValue } from "./Ledger.tsx";
import { trails, usage14 } from "../storybook/data.ts";

const meta = { title: "Usage/LedgerFilters", component: LedgerFilters } satisfies Meta<typeof LedgerFilters>;
export default meta;
type Story = StoryObj<typeof meta>;

const engines = usage14.byEngine.map((g) => g.key);
const ids = trails.map((t) => ({ id: t.id, short: t.short }));
export const Clear: Story = { args: { value: noFilters, engines, trails: ids, onChange: () => undefined } };
export const Interactive: Story = {
  args: { value: noFilters, engines, trails: ids, onChange: () => undefined },
  render: (args) => { const [v, setV] = useState<LedgerFilterValue>({ ...noFilters, persona: "nema", outcome: "unknown-cost" }); return <LedgerFilters {...args} value={v} onChange={setV} />; },
};
export const Mobile: Story = { args: { value: noFilters, engines, trails: ids, onChange: () => undefined }, globals: { viewport: { value: "phone" } } };
