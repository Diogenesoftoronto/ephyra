import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SetupMode } from "@ephyra/core";
import { AutomaticSetup, SetupModeChoice, SetupProgress } from "./AutomaticSetup.tsx";
import { FakeSetupApi, SETUP_FIXTURE } from "../fake/setup.ts";
import "./AccountForms.css";
import "../pages/OnboardingPage.css";

const meta: Meta = { title: "Account/Automatic setup" };
export default meta;
function Choices() {
  const [mode, setMode] = useState<SetupMode>("autonomous");
  return <SetupModeChoice value={mode} onChange={setMode} />;
}
function InterruptedExample() {
  const [api] = useState(() => new FakeSetupApi({ uncertain: true }));
  return <AutomaticSetup api={api} account="fixture-interrupted" workspace="fixture" initialMode="autonomous" onOpen={() => {}} />;
}
export const Mode: StoryObj = { render: () => <Choices /> };
export const Blocked: StoryObj = { render: () => <SetupProgress run={SETUP_FIXTURE} /> };
export const Running: StoryObj = {
  render: () => <SetupProgress run={{ ...SETUP_FIXTURE, status: "running", blockers: [], artifacts: [], steps: [
    { id: "inspect", name: "Inspect repository", status: "complete", detail: "Fixture: package manifests found." },
    { id: "documents", name: "Prepare autonomy documents", status: "running", detail: "Fixture: preparing verification plan." },
  ] }} />,
};
export const Interrupted: StoryObj = { render: () => <InterruptedExample /> };
export const Phone: StoryObj = { ...Blocked, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Blocked, parameters: { theme: "dark" } };
