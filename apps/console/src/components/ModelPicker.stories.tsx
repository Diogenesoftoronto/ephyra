import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelPicker, type ModelPickerProps } from "./ModelPicker.tsx";
import { MODEL_CATALOG_URL, type ModelCatalog } from "../model-catalog.ts";

// Deliberate Storybook fixtures: no public catalog or provider is contacted.
const catalog: ModelCatalog = {
  source: MODEL_CATALOG_URL,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      adapter: "openai",
      models: [
        {
          id: "fixture-reasoning-model",
          name: "Reasoning model fixture",
          contextTokens: 128_000,
          outputTokens: 16_000,
          inputUsdPerMillion: 1.25,
          outputUsdPerMillion: 5,
          tieredPricing: false,
          tools: true,
          reasoning: true,
        },
        {
          id: "fixture-fast-model",
          name: "Fast model fixture",
          contextTokens: 64_000,
          outputTokens: 8000,
          inputUsdPerMillion: 0.2,
          outputUsdPerMillion: 0.8,
          tieredPricing: false,
          tools: true,
          reasoning: false,
        },
        {
          id: "fixture-unknown-model",
          name: "Unknown metadata fixture",
          contextTokens: null,
          outputTokens: null,
          inputUsdPerMillion: null,
          outputUsdPerMillion: null,
          tieredPricing: false,
          tools: null,
          reasoning: null,
        },
      ],
    },
    {
      id: "compatible-fixture",
      name: "Compatible fixture",
      adapter: "openai-compatible",
      api: "https://provider.example.com/v1",
      models: [
        {
          id: "vendor/exact-model-id",
          name: "Compatible model fixture",
          contextTokens: 200_000,
          outputTokens: 32_000,
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 8,
          tieredPricing: true,
          tools: true,
          reasoning: true,
        },
      ],
    },
  ],
};
const ready = async () => catalog;
const unavailable = async () => {
  throw new Error("Offline fixture");
};
const loading = () => new Promise<ModelCatalog>(() => {});
const meta: Meta<typeof ModelPicker> = { title: "Account/ModelPicker", component: ModelPicker };
export default meta;
type Story = StoryObj<typeof ModelPicker>;
function PickerStory(props: Partial<ModelPickerProps>) {
  const [value, setValue] = useState(props.value ?? "");
  return (
    <div style={{ maxWidth: 620, display: "grid", gap: "1rem" }}>
      <p className="muted">Storybook catalog fixture. IDs and prices are examples.</p>
      <ModelPicker provider="openai" loadCatalog={ready} {...props} value={value} onChange={setValue} />
      <p className="muted">
        Exact selected ID: <code data-model-selection>{value || "None"}</code>
      </p>
      <button type="button">Next form control</button>
    </div>
  );
}
export const Default: Story = { render: () => <PickerStory /> };
export const Selected: Story = { render: () => <PickerStory value="fixture-reasoning-model" /> };
export const ManualId: Story = { render: () => <PickerStory value="my-private-model/exact-revision" /> };
export const Compatible: Story = {
  render: () => <PickerStory provider="compatible" baseUrl="https://provider.example.com/v1" />,
};
export const UnknownBaseUrl: Story = {
  render: () => <PickerStory provider="compatible" baseUrl="https://custom.example.com/v1" />,
};
export const Hosted: Story = { render: () => <PickerStory provider="notorganic" value="account-specific-model" /> };
export const Loading: Story = { render: () => <PickerStory loadCatalog={loading} /> };
export const Unavailable: Story = { render: () => <PickerStory loadCatalog={unavailable} /> };
export const Disabled: Story = { render: () => <PickerStory value="fixture-reasoning-model" disabled /> };
export const Phone: Story = { ...Selected, globals: { viewport: { value: "phone" } } };
export const Dark: Story = {
  render: () => (
    <div data-theme="dark" style={{ background: "var(--bg)", color: "var(--ink)", padding: "1rem" }}>
      <PickerStory />
    </div>
  ),
};
export const InsideClippedPanel: Story = {
  render: () => (
    <div style={{ height: 190, overflow: "hidden", maxWidth: 620 }}>
      <PickerStory />
    </div>
  ),
};
