import { useId, useState } from "react";
import { PageHeader, Button } from "../kit.ts";
import { ModelAccessForm, RepositoryForm, type AccountPageProps } from "../components/AccountForms.tsx";
import { KnowledgeConnections } from "../components/KnowledgeConnections.tsx";
import { AutomationStatus, ConnectionPanels } from "../components/ConnectionPanels.tsx";
import "./SettingsPage.css";

const sections = [
  { id: "repository", label: "Repository" },
  { id: "models", label: "Model access" },
  { id: "knowledge", label: "Connections" },
  { id: "account", label: "Account" },
] as const;
export type SettingsSection = (typeof sections)[number]["id"];

export function SettingsPage({
  api,
  settings,
  onChange,
  onDone,
  onResumeSetup,
  loadCatalog,
  alias,
  onDisconnect,
  disconnectLabel = "Sign out",
  initialSection = "repository",
}: AccountPageProps & { onResumeSetup?: () => void; initialSection?: SettingsSection; alias?: string; onDisconnect?: () => void; disconnectLabel?: string }) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const id = useId();
  return (
    <div className="account-page settings-page">
      <PageHeader
        title="Settings"
        actions={
          onDone && (
            <Button variant="ghost" onClick={onDone}>
              Open workspace
            </Button>
          )
        }
      />
      <div className="settings-sections" role="tablist" aria-label="Settings sections">
        {sections.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}-tab`}
            aria-controls={`${id}-${item.id}-panel`}
            aria-selected={section === item.id}
            tabIndex={section === item.id ? 0 : -1}
            onClick={() => setSection(item.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? sections.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % sections.length
                      : event.key === "ArrowLeft"
                        ? (index + sections.length - 1) % sections.length
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              setSection(sections[next].id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {/* Keep each form mounted so section navigation retains unsaved input. */}
      <section
        role="tabpanel"
        id={`${id}-repository-panel`}
        aria-labelledby={`${id}-repository-tab`}
        hidden={section !== "repository"}
        tabIndex={0}
        className="settings-panel"
      >
        <AutomationStatus settings={settings} />
        <RepositoryForm api={api} settings={settings} onChange={onChange} />
      </section>
      <section
        role="tabpanel"
        id={`${id}-models-panel`}
        aria-labelledby={`${id}-models-tab`}
        hidden={section !== "models"}
        tabIndex={0}
        className="settings-panel"
      >
        <ModelAccessForm api={api} settings={settings} onChange={onChange} loadCatalog={loadCatalog} />
      </section>
      <section
        role="tabpanel"
        id={`${id}-knowledge-panel`}
        aria-labelledby={`${id}-knowledge-tab`}
        hidden={section !== "knowledge"}
        tabIndex={0}
        className="settings-panel"
      >
        <KnowledgeConnections api={api} settings={settings} onChange={onChange} />
        <ConnectionPanels api={api} settings={settings} onChange={onChange} />
      </section>
      <section
        role="tabpanel"
        id={`${id}-account-panel`}
        aria-labelledby={`${id}-account-tab`}
        hidden={section !== "account"}
        tabIndex={0}
        className="settings-panel"
      >
        <dl className="settings-account-details">
          <div>
            <dt>Alias</dt>
            <dd>{alias ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Signed in with</dt>
            <dd>Not Organic</dd>
          </div>
          <div>
            <dt>Identity</dt>
            <dd>
              <code>{settings.did}</code>
            </dd>
          </div>
          <div>
            <dt>Setup</dt>
            <dd>
              {
                { new: "Not started", in_progress: "In progress", skipped: "Saved for later", complete: "Complete" }[
                  settings.onboarding.status
                ]
              }
            </dd>
          </div>
        </dl>
        {onDisconnect && (
          <div className="account-actions">
            <Button variant="ghost" onClick={onDisconnect} disabled={disconnectLabel === "Signing out…"}>
              {disconnectLabel}
            </Button>
          </div>
        )}
        <a href="/auth/login?setup=1">Update account permissions</a>
        {onResumeSetup && (
          <div className="account-actions">
            <Button onClick={onResumeSetup}>
              {settings.onboarding.status === "complete" ? "Review setup" : "Resume setup"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
