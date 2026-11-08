import type { Meta, StoryObj } from "@storybook/react-vite";
import { PublishBar } from "./PublishBar.tsx";
import { draft } from "../storybook/data.ts";
import { ApiError } from "../api.ts";
import type { Draft, PolicyActivationReceipt } from "@ephyra/core";
import type { PolicyActivationControls } from "../app/policyActivationSession.ts";
const meta: Meta = { title: "Components/PublishBar" };
export default meta;
export const Default: StoryObj = {
  render: () => (
    <PublishBar draft={draft} onPublish={async () => undefined} onDiscard={async () => undefined} />
  ),
};
export const Conflict: StoryObj = {
  render: () => (
    <PublishBar
      draft={draft}
      onPublish={async () => {
        throw new ApiError(409);
      }}
      onDiscard={async () => undefined}
    />
  ),
};
export const ReadOnly: StoryObj = {
  render: () => (
    <PublishBar
      draft={draft}
      canPublish={false}
      onPublish={async () => undefined}
      onDiscard={async () => undefined}
    />
  ),
};

const published: Draft = { ...draft, status: "published", published: { ref: `refs/ephyra/policy/${draft.id}`,
  commit: "a".repeat(40), by: "did:example:reviewer", at: "2026-11-08T12:00:00.000Z" } };
const receipt: PolicyActivationReceipt = { schema: 1, draftId: draft.id, path: draft.path, sourceCommit: "a".repeat(40),
  sourceDigest: "b".repeat(64), principal: "did:example:reviewer", at: "2026-11-08T12:00:00.000Z", previousActive: null,
  requestDigest: "c".repeat(64), documents: [{ path: draft.path, digest: "b".repeat(64) }], commit: "d".repeat(40) };
const activation: PolicyActivationControls = { status: "ready", active: null, busy: false, current: false,
  activate: async () => undefined, reload: async () => undefined };
export const Published: StoryObj = {
  render: () => <PublishBar draft={published} activation={activation}
    onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
export const Active: StoryObj = {
  render: () => <PublishBar draft={published} activation={{ ...activation, active: receipt, current: true }}
    onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
export const CheckingActivation: StoryObj = {
  render: () => <PublishBar draft={published} activation={{ ...activation, status: "loading" }}
    onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
export const UnconfirmedActivation: StoryObj = {
  render: () => <PublishBar draft={published} activation={{ ...activation, pending: {
    key: "fixture-activation-operation", path: draft.path, expectedCommit: "a".repeat(40), expectedDigest: "b".repeat(64), expectedActive: null,
  } }} onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
export const ActivationConflict: StoryObj = {
  render: () => <PublishBar draft={published} activation={{ ...activation, error: new ApiError(409, "The active policy changed.") }}
    onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
export const PublishedReadOnly: StoryObj = {
  render: () => <PublishBar draft={published} activation={activation} canPublish={false}
    onPublish={async () => undefined} onDiscard={async () => undefined} />,
};
