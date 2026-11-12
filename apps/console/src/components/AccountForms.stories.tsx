import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccountSaveFeedback, ModelAccessForm, RepositoryForm, SetupReview } from "./AccountForms.tsx";
import {
  ACCOUNT_FIXTURE,
  CONNECTED_ACCOUNT_FIXTURE,
  FakeAccountApi,
  loadAccountCatalogFixture,
  type FakeAccountOptions,
} from "../fake/account.ts";
import { ApiError } from "../api.ts";
const meta: Meta = { title: "Account/Forms" };
export default meta;
function FormStory({ model, options = {} }: { model?: boolean; options?: FakeAccountOptions }) {
  const [api] = useState(() => new FakeAccountApi(options));
  const [settings, setSettings] = useState(options.initial ?? ACCOUNT_FIXTURE);
  const Form = model ? ModelAccessForm : RepositoryForm;
  return (
    <div style={{ maxWidth: 680 }}>
      <p className="account-hint">Storybook fixture. No repository or provider is contacted.</p>
      <Form api={api} settings={settings} onChange={setSettings} loadCatalog={loadAccountCatalogFixture} />
    </div>
  );
}
export const Repository: StoryObj = { render: () => <FormStory /> };
export const ConnectedRepository: StoryObj = {
  render: () => <FormStory options={{ initial: CONNECTED_ACCOUNT_FIXTURE }} />,
};
export const ModelAccess: StoryObj = { render: () => <FormStory model /> };
export const SavedKey: StoryObj = {
  render: () => (
    <FormStory
      model
      options={{
        initial: {
          ...CONNECTED_ACCOUNT_FIXTURE,
          model: {
            ...CONNECTED_ACCOUNT_FIXTURE.model,
            provider: "openai",
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
  render: () => <AccountSaveFeedback state={{ kind: "saving" }} onRefresh={() => {}} />,
};
export const Error: StoryObj = {
  render: () => (
    <AccountSaveFeedback
      state={{
        kind: "error",
        message: "The repository branch could not be fetched. Check the URL, branch and access token.",
      }}
      onRefresh={() => {}}
    />
  ),
};
export const Stale: StoryObj = {
  render: () => (
    <AccountSaveFeedback
      state={{
        kind: "stale",
        message: "Settings changed in another window. Refresh saved settings, then review your changes.",
      }}
      onRefresh={() => {}}
    />
  ),
};
export const Uncertain: StoryObj = {
  render: () => (
    <AccountSaveFeedback
      state={{
        kind: "uncertain",
        message: "The save may have completed. Refresh saved settings before making another change.",
      }}
      onRefresh={() => {}}
    />
  ),
};
export const Review: StoryObj = { render: () => <SetupReview settings={CONNECTED_ACCOUNT_FIXTURE} /> };
export const ReviewWithoutProvider: StoryObj = { render: () => <SetupReview settings={ACCOUNT_FIXTURE} /> };
export const FailedSave: StoryObj = {
  render: () => (
    <FormStory
      options={{
        initial: CONNECTED_ACCOUNT_FIXTURE,
        fail: { saveRepository: new ApiError(422, "Fixture: branch could not be fetched.") },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-account-action="save-repository"]')?.click();
  },
};
export const Phone: StoryObj = { ...SavedKey, globals: { viewport: { value: "phone" } } };

export const ReviewModel: StoryObj = {
  render: () => {
    const [api] = useState(() => new FakeAccountApi({ initial: CONNECTED_ACCOUNT_FIXTURE }));
    const [settings, setSettings] = useState(CONNECTED_ACCOUNT_FIXTURE);
    return (
      <div style={{ maxWidth: 680 }}>
        <p className="account-hint">Storybook fixture. No provider is contacted.</p>
        <ModelAccessForm api={api} settings={settings} onChange={setSettings} loadCatalog={loadAccountCatalogFixture} role="review" />
      </div>
    );
  },
};
