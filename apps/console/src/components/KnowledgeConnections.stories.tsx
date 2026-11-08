import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AccountSettings, KnowledgeCatalog } from "@ephyra/core";
import { KnowledgeConnections, KnowledgeSource } from "./KnowledgeConnections.tsx";
import { ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";
import { KNOWLEDGE_CATALOG_FIXTURE, KNOWLEDGE_SELECTION_FIXTURE } from "../fake/knowledge.ts";
import "./AccountForms.css";

const meta: Meta = { title: "Account/Knowledge connections" };
export default meta;
const enabled: AccountSettings = {
  ...ACCOUNT_FIXTURE,
  knowledge: { enabled: true, workspaceId: ACCOUNT_FIXTURE.workspaceId, sources: [], updatedAt: "2026-11-08T12:00:00.000Z" },
};
function Example({ initial = enabled, catalog = KNOWLEDGE_CATALOG_FIXTURE }: {
  initial?: AccountSettings; catalog?: KnowledgeCatalog;
}) {
  const [settings, setSettings] = useState(initial);
  const [api] = useState(() => new FakeAccountApi({ initial, knowledgeCatalog: catalog }));
  return <div className="account-page">
    <p className="account-hint">Fictional connections. No account or external source is contacted.</p>
    <KnowledgeConnections api={api} settings={settings} onChange={setSettings} />
  </div>;
}
export const Optional: StoryObj = { render: () => <Example initial={ACCOUNT_FIXTURE} /> };
export const Available: StoryObj = { render: () => <Example /> };
export const NeedsSignIn: StoryObj = {
  render: () => <Example catalog={{ ...KNOWLEDGE_CATALOG_FIXTURE, status: "needs_sign_in", sources: [],
    detail: "Continue with Not Organic to allow Ephyra to use your chosen connections." }} />,
};
export const NoSources: StoryObj = { render: () => <Example catalog={{ ...KNOWLEDGE_CATALOG_FIXTURE, sources: [] }} /> };
export const Unavailable: StoryObj = {
  render: () => <Example initial={{ ...enabled, knowledge: { ...enabled.knowledge!, sources: KNOWLEDGE_SELECTION_FIXTURE } }}
    catalog={{ ...KNOWLEDGE_CATALOG_FIXTURE, status: "unavailable", sources: [], detail: "Connections are temporarily unavailable." }} />,
};
export const Revoked: StoryObj = {
  render: () => <Example initial={{ ...enabled, knowledge: { ...enabled.knowledge!, sources: KNOWLEDGE_SELECTION_FIXTURE } }}
    catalog={{ ...KNOWLEDGE_CATALOG_FIXTURE, sources: [] }} />,
};
export const ChangedDefinition: StoryObj = {
  render: () => <Example initial={{ ...enabled, knowledge: { ...enabled.knowledge!, sources: KNOWLEDGE_SELECTION_FIXTURE } }}
    catalog={{ ...KNOWLEDGE_CATALOG_FIXTURE, sources: [{ ...KNOWLEDGE_CATALOG_FIXTURE.sources[0]!,
      tools: [{ ...KNOWLEDGE_CATALOG_FIXTURE.sources[0]!.tools[0]!, definitionHash: "d".repeat(64) }],
    }] }} />,
};
export const ToolDetails: StoryObj = {
  render: () => <KnowledgeSource source={KNOWLEDGE_CATALOG_FIXTURE.sources[1]!} onChange={() => {}} />,
};
export const Phone: StoryObj = { ...Available, globals: { viewport: { value: "phone" } } };
export const Dark: StoryObj = { ...Available, parameters: { theme: "dark" } };
