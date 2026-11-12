import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TelemetrySources, TelemetrySourceForm } from "./TelemetrySources.tsx";
import { TELEMETRY_PROVIDERS } from "./telemetry-catalog.ts";
import { ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";
import "./AccountForms.css";

const meta: Meta = { title: "Account/Telemetry sources" };
export default meta;
function Example({ provider, uncertain = false }: { provider?: string; uncertain?: boolean }) {
  const [settings, setSettings] = useState(ACCOUNT_FIXTURE);
  const [api] = useState(() => new FakeAccountApi({ uncertainAfterSave: uncertain ? ["saveTelemetrySource"] : [] }));
  const selected = TELEMETRY_PROVIDERS.find((item) => item.id === provider);
  return <div className="account-page"><p className="account-hint">Fictional connections. No provider is contacted or verified.</p>
    {selected ? <TelemetrySourceForm provider={selected} api={api} settings={settings} onChange={setSettings} />
      : <TelemetrySources api={api} settings={settings} onChange={setSettings} />}
  </div>;
}
export const ChooseSource: StoryObj = { render: () => <Example /> };
export const Sentry: StoryObj = { render: () => <Example provider="sentry" /> };
export const Crashlytics: StoryObj = { render: () => <Example provider="crashlytics" /> };
export const Loki: StoryObj = { render: () => <Example provider="loki" /> };
export const Axiom: StoryObj = { render: () => <Example provider="axiom" /> };
export const BetterStack: StoryObj = { render: () => <Example provider="betterstack" /> };
export const Datadog: StoryObj = { render: () => <Example provider="datadog" /> };
export const BugSnag: StoryObj = { render: () => <Example provider="bugsnag" /> };
export const UncertainSave: StoryObj = { render: () => <Example provider="sentry" uncertain /> };
export const Phone: StoryObj = { ...ChooseSource, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...ChooseSource, parameters: { theme: "dark" } };
