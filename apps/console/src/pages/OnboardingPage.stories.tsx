import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { OnboardingPage } from "./OnboardingPage.tsx";
import {
  ACCOUNT_FIXTURE,
  CONNECTED_ACCOUNT_FIXTURE,
  FakeAccountApi,
  loadAccountCatalogFixture,
  type FakeAccountOptions,
} from "../fake/account.ts";
import { ApiError } from "../api.ts";
import { FakeSetupApi, SETUP_FIXTURE } from "../fake/setup.ts";
import type { SetupRun } from "@ephyra/core";
const meta: Meta = { title: "Screens/OnboardingPage" };
export default meta;
function OnboardingStory({ options = {}, setup }: { options?: FakeAccountOptions; setup?: SetupRun }) {
  const [api] = useState(() => new FakeAccountApi(options));
  const [automation] = useState(() => new FakeSetupApi({ initial: setup }));
  const [settings, setSettings] = useState(options.initial ?? ACCOUNT_FIXTURE);
  const [done, setDone] = useState(false);
  return (
    <>
      <p className="account-hint">Storybook fixture. No repository or provider is contacted.</p>
      {done ? (
        <p role="status">Fixture: workspace opened. Setup is {settings.onboarding.status}.</p>
      ) : (
        <OnboardingPage
          api={api}
          automation={automation}
          settings={settings}
          onChange={setSettings}
          onDone={() => setDone(true)}
          loadCatalog={loadAccountCatalogFixture}
        />
      )}
    </>
  );
}
export const Initial: StoryObj = { render: () => <OnboardingStory /> };
export const ResumeModelAccess: StoryObj = {
  render: () => (
    <OnboardingStory options={{ initial: { ...CONNECTED_ACCOUNT_FIXTURE, model: ACCOUNT_FIXTURE.model } }} />
  ),
};
export const Review: StoryObj = { render: () => <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} /> };
export const Skipped: StoryObj = {
  render: () => (
    <OnboardingStory
      options={{ initial: { ...ACCOUNT_FIXTURE, onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "skipped" } } }}
    />
  ),
};
export const Loading: StoryObj = {
  render: () => <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE, hang: ["onboarding"] }} />,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-account-action="finish-setup"]')?.click();
  },
};
export const Error: StoryObj = {
  render: () => (
    <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE, fail: { onboarding: new ApiError(409) } }} />
  ),
  play: Loading.play,
};
export const Phone: StoryObj = { ...Initial, globals: { viewport: { value: "phone" } } };
export const PhoneModelAccess: StoryObj = { ...ResumeModelAccess, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Review, parameters: { theme: "dark" } };

export const AutomaticProgress: StoryObj = {
  render: () => <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} setup={{
    ...SETUP_FIXTURE, status: "running", blockers: [], artifacts: [], steps: [
      { id: "inspect", name: "Inspect repository", status: "running", detail: "Fixture: reading repository metadata." },
      { id: "documents", name: "Prepare autonomy documents", status: "pending", detail: "Waiting for repository inspection." },
    ],
  }} />,
};
export const NeedsConnection: StoryObj = {
  render: () => <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} setup={SETUP_FIXTURE} />,
};
export const Supervised: StoryObj = {
  render: () => <OnboardingStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} setup={{ ...SETUP_FIXTURE, mode: "supervised" }} />,
};
