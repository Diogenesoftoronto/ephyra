import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPage } from "./SettingsPage.tsx";
import {
  ACCOUNT_FIXTURE,
  CONNECTED_ACCOUNT_FIXTURE,
  FakeAccountApi,
  loadAccountCatalogFixture,
  type FakeAccountOptions,
} from "../fake/account.ts";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Screens/SettingsPage" };
export default meta;
function SettingsStory({ options = {} }: { options?: FakeAccountOptions }) {
  const [api] = useState(() => new FakeAccountApi(options));
  const [settings, setSettings] = useState(options.initial ?? ACCOUNT_FIXTURE);
  return (
    <>
      <p className="account-hint">Storybook fixture. No repository or provider is contacted.</p>
      <SettingsPage
        api={api}
        settings={settings}
        onChange={setSettings}
        onDone={() => {}}
        onResumeSetup={() => {}}
        loadCatalog={loadAccountCatalogFixture}
      />
    </>
  );
}
export const Initial: StoryObj = { render: () => <SettingsStory /> };
export const Connected: StoryObj = { render: () => <SettingsStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} /> };
export const SavedKey: StoryObj = {
  render: () => (
    <SettingsStory
      options={{
        initial: {
          ...CONNECTED_ACCOUNT_FIXTURE,
          model: {
            ...CONNECTED_ACCOUNT_FIXTURE.model,
            provider: "anthropic",
            model: "storybook-model",
            keyConfigured: true,
            status: "saved",
            detail: "Fixture: key stored, no inference request performed.",
          },
        },
      }}
    />
  ),
};
export const Loading: StoryObj = {
  render: () => <SettingsStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE, hang: ["saveRepository"] }} />,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-account-action="save-repository"]')?.click();
  },
};
export const Error: StoryObj = {
  render: () => (
    <SettingsStory
      options={{
        initial: CONNECTED_ACCOUNT_FIXTURE,
        fail: { saveRepository: new ApiError(422, "Fixture: repository could not be reached.") },
      }}
    />
  ),
  play: Loading.play,
};
export const UncertainSave: StoryObj = {
  render: () => (
    <SettingsStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE, uncertainAfterSave: ["saveRepository"] }} />
  ),
  play: Loading.play,
};
export const Skipped: StoryObj = {
  render: () => (
    <SettingsStory
      options={{ initial: { ...ACCOUNT_FIXTURE, onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "skipped" } } }}
    />
  ),
};
export const Dark: StoryObj = { ...Connected, parameters: { theme: "dark" } };
export const Phone: StoryObj = { ...SavedKey, globals: { viewport: { value: "phone" } } };
