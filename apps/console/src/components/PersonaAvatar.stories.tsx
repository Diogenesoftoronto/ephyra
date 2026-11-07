import type { Meta, StoryObj } from "@storybook/react-vite";
import { PERSONAS } from "@ephyra/core";
import { PersonaAvatar } from "./PersonaAvatar.tsx";

const meta = { title: "Personas/PersonaAvatar", component: PersonaAvatar } satisfies Meta<typeof PersonaAvatar>;
export default meta;
type Story = StoryObj<typeof meta>;

const row = (size: 24 | 32 | 48 | 96, live = false) => (
  <div className="cluster">{PERSONAS.map((p) => <PersonaAvatar key={p.id} persona={p.id} size={size} live={live} />)}</div>
);

/** With no art served, each persona shows its initial on its colour. This is the fallback, and what ships until the files exist. */
export const Fallback: Story = { args: { persona: "rho" }, render: () => <div className="stack">{row(24)}{row(32)}{row(48)}{row(96)}</div> };
export const Live: Story = { args: { persona: "nema" }, render: () => row(48, true) };
export const Dark: Story = { args: { persona: "velum" }, parameters: { theme: "dark" }, render: () => <div className="stack">{row(32)}{row(96)}</div> };
