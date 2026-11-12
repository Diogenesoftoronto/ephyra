import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AccountSettings } from "@ephyra/core";
import { MirrorsForm } from "./MirrorsForm.tsx";
import { CONNECTED_ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";

const meta: Meta = { title: "Account/Mirrors" };
export default meta;

const github: AccountSettings = { ...CONNECTED_ACCOUNT_FIXTURE, repository: { ...CONNECTED_ACCOUNT_FIXTURE.repository!,
  url: "https://github.com/acme/app.git", credentialConfigured: true,
  forge: { kind: "github", source: "https://github.com/acme/app", cloneUrl: "https://github.com/acme/app.git" } } };

function Story({ initial }: { initial: AccountSettings }) {
  const [api] = useState(() => new FakeAccountApi({ initial }));
  const [settings, setSettings] = useState(initial);
  return (
    <div style={{ maxWidth: 680 }}>
      <p className="account-hint">Storybook fixture. No repository is contacted.</p>
      <MirrorsForm api={api} settings={settings} onChange={setSettings} />
    </div>
  );
}

export const Empty: StoryObj = { render: () => <Story initial={github} /> };
export const WithResults: StoryObj = { render: () => <Story initial={{ ...github, mirrors: [
  { id: "m_000000000001", url: "https://gitlab.com/acme/app.git", host: "gitlab.com", kind: "gitlab", credentialConfigured: true,
    last: { status: "ok", at: "2026-11-12T06:00:00.000Z", commit: "a".repeat(40), detail: "Pushed." } },
  { id: "m_000000000002", url: "https://git.example.org/acme/app", host: "git.example.org", kind: "forgejo", credentialConfigured: false,
    last: { status: "failed", at: "2026-11-12T06:00:00.000Z", detail: "The mirror has commits the workspace does not. It was left as it is." } },
] }} /> };
export const NoToken: StoryObj = { render: () => <Story initial={{ ...github, repository: { ...github.repository!, credentialConfigured: false } }} /> };
export const Phone: StoryObj = { ...WithResults, parameters: { viewport: { defaultViewport: "mobile1" } } };
