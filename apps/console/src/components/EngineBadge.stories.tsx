import type { Meta, StoryObj } from "@storybook/react-vite";
import { EngineBadge } from "./EngineBadge.tsx";
const meta: Meta = { title: "Components/EngineBadge" };
export default meta;
export const Default: StoryObj = { render: () => (
  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
    <EngineBadge engine="amp/smart" executor={{ kind: "orb", id: "orb-7qm2x", project: "Fixture workspace" }} />
    <EngineBadge engine="codex/gpt-6-codex" executor={{ kind: "runner", id: "fixture-runner-codex" }} />
    <EngineBadge engine="claude-code/claude-opus-5-5" executor={{ kind: "local", id: "fixture-process-42" }} />
    <EngineBadge engine="judgement-jev/jev-1.14" />
    <EngineBadge />
  </div>
) };
export const Dark: StoryObj = { ...Default, parameters: { theme: "dark" } };
export const LongIdentity: StoryObj = { render: () => (
  <div style={{ display: "flex", justifyContent: "end" }}>
    <EngineBadge engine={`custom/${"unabridged-recorded-model-".repeat(6)}`}
      executor={{ kind: "railway", id: "fixture-sandbox-".repeat(8), project: "Fixture workspace with a long project name" }} />
  </div>
) };
