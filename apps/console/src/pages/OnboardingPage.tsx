import { useState } from "react";
import type { SetupMode } from "@ephyra/core";
import { Button } from "../kit.ts";
import {
  AccountSaveFeedback, ModelAccessForm, RepositoryForm, type AccountPageProps,
} from "../components/AccountForms.tsx";
import { useAccountWrite } from "../components/useAccountWrite.ts";
import { JellySpecimen } from "../components/JellySpecimen.tsx";
import { AutomaticSetup, SetupModeChoice } from "../components/AutomaticSetup.tsx";
import { KnowledgeConnections } from "../components/KnowledgeConnections.tsx";
import { AutomationStatus, ConnectionPanels } from "../components/ConnectionPanels.tsx";
import "./OnboardingPage.css";

export function OnboardingPage({ api, settings, onChange, onDone, loadCatalog, automation }: AccountPageProps) {
  const [mode, setModeValue] = useState<SetupMode>(() => {
    try { return localStorage.getItem(`ephyra.setup.mode:${settings.did}`) === "supervised" ? "supervised" : "autonomous"; }
    catch { return "autonomous"; }
  });
  const setMode = (value: SetupMode) => {
    setModeValue(value);
    try { localStorage.setItem(`ephyra.setup.mode:${settings.did}`, value); } catch { /* memory only */ }
  };
  const write = useAccountWrite(api, onChange);
  const [formBusy, setFormBusy] = useState(false);
  const locked = write.locked || formBusy;
  async function open(ready: boolean) {
    const next = await write.save(
      { expectedVersion: settings.version, action: ready ? "complete" as const : "skip" as const },
      (value, key) => api.onboarding(value, key),
      ready ? "Setup saved." : "Setup progress is saved. You can return at any time.",
    );
    if (next) onDone?.();
  }
  return (
    <div className="account-page onboarding-page">
      <header className="ui-page-header onboarding-heading">
        <div className="onboarding-heading__text">
          <p className="onboarding-eyebrow">A little help for the work ahead</p>
          <h1>{settings.repository ? "Your application’s setup" : "Give your application a companion."}</h1>
          <p className="account-hint">
            Connect your repository. Ephyra inspects it, prepares autonomy documents, and checks what it needs to run.
          </p>
          {!settings.repository && (
            <Button variant="ghost" disabled={locked} onClick={() => void open(false)} data-account-action="skip-setup">
              Explore first
            </Button>
          )}
        </div>
        <div className="onboarding-companion"><JellySpecimen size={220} /></div>
      </header>
      <div className="onboarding-layout">
      <ol className="onboarding-explainer" aria-label="Setting up your workspace">
        <li aria-current={!settings.repository ? "step" : undefined}><span>01</span><strong>Connect a repository</strong></li>
        <li aria-current={settings.repository ? "step" : undefined}><span>02</span><strong>Prepare the application</strong></li>
        <li><span>03</span><strong>Follow the work together</strong></li>
      </ol>
      <div className="onboarding-content">
        {settings.repository && <AutomationStatus settings={settings} />}
        {settings.repository ? automation ? (
          <AutomaticSetup
            key={settings.workspaceId}
            api={automation}
            account={settings.did}
            workspace={settings.workspaceId}
            initialMode={mode}
            onOpen={(ready) => { if (!locked) void open(ready); }}
          />
        ) : (
          <div className="account-feedback" data-tone="warning" role="status">
            <strong>Automatic setup is unavailable on this connection.</strong>
            <p>Your repository is saved. The deployment needs an automatic setup service before it can prepare the application.</p>
            <Button onClick={() => void open(false)} disabled={locked}>Open workspace</Button>
          </div>
        ) : (
          <>
            <SetupModeChoice value={mode} onChange={setMode} disabled={locked} />
            <RepositoryForm
              api={api} settings={settings} onChange={onChange} onBusyChange={setFormBusy}
              submitLabel="Connect and set up automatically"
            />
          </>
        )}
        <details className="onboarding-context" open={settings.repository || settings.knowledge?.enabled ? true : undefined}>
          <summary>Connect knowledge and research tools <span className="muted">· optional</span></summary>
          <KnowledgeConnections api={api} settings={settings} onChange={onChange} />
        </details>
        <ConnectionPanels api={api} settings={settings} onChange={onChange} />
        {settings.repository && (
          <details className="account-advanced">
            <summary>Model access and repository settings</summary>
            <div className="account-advanced-fields">
              <ModelAccessForm api={api} settings={settings} onChange={onChange} loadCatalog={loadCatalog} onBusyChange={setFormBusy} />
              <RepositoryForm api={api} settings={settings} onChange={onChange} onBusyChange={setFormBusy} />
            </div>
          </details>
        )}
        <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      </div>
      </div>
    </div>
  );
}
