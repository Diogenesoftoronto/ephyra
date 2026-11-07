import type { Meta, StoryObj } from "@storybook/react-vite";
import { PERSONAS } from "@ephyra/core";
import { PersonaLabel } from "./PersonaLabel.tsx";

const meta = { title: "Personas/PersonaLabel", component: PersonaLabel } satisfies Meta<typeof PersonaLabel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const All: Story = { args: { persona: "rho" }, render: () => <div className="stack-sm">{PERSONAS.map((p) => <PersonaLabel key={p.id} persona={p.id} />)}</div> };
export const Unattributed: Story = { args: { persona: null } };
export const Dark: Story = { args: { persona: "lappet" }, parameters: { theme: "dark" } };
