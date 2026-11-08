import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AccountSettings } from "@ephyra/core";
import { AutomationStatus, ConnectionPanels } from "./ConnectionPanels.tsx";
import { ACCOUNT_FIXTURE, FakeAccountApi, type FakeAccountOptions } from "../fake/account.ts";
import { CONNECTION_ACCOUNT_FIXTURE } from "../fake/connections.ts";
import "./AccountForms.css";

const meta: Meta = { title: "Account/Signal and people connections" };
export default meta;
function Example({ initial = ACCOUNT_FIXTURE, options }: { initial?: AccountSettings; options?: FakeAccountOptions }) {
  const [settings, setSettings] = useState(initial);
  const [api] = useState(() => new FakeAccountApi({ ...options, initial }));
  return <div className="account-page">
    <p className="account-hint">Fictional connections. No external service is contacted and no job has run.</p>
    <AutomationStatus settings={settings} />
    <ConnectionPanels api={api} settings={settings} onChange={setSettings} />
  </div>;
}
export const Optional: StoryObj = { render: () => <Example /> };
export const Saved: StoryObj = { render: () => <Example initial={CONNECTION_ACCOUNT_FIXTURE} /> };
export const Unavailable: StoryObj = { render: () => <Example initial={{ ...CONNECTION_ACCOUNT_FIXTURE,
  telemetry: { ...CONNECTION_ACCOUNT_FIXTURE.telemetry!, status: "unavailable", detail: "Fixture: project access could not be checked." },
}} /> };
export const InterruptedSave: StoryObj = { render: () => <Example initial={CONNECTION_ACCOUNT_FIXTURE}
  options={{ uncertainAfterSave: ["saveTelemetry", "savePeople"] }} /> };
export const Phone: StoryObj = { ...Saved, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Saved, parameters: { theme: "dark" } };
