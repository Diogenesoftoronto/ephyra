import { useEffect, useId, useState } from "react";
import { PageHeader, Button, Icon, Tag } from "../kit.ts";
import {
  ModelAccessForm,
  RepositoryForm,
  SetupReview,
  modelProviderName,
  type AccountPageProps,
} from "../components/AccountForms.tsx";
import "./SettingsPage.css";

const sections = [
  { id: "repository", label: "Repository", icon: "runs" },
  { id: "models", label: "Model access", icon: "specimen" },
  { id: "account", label: "Account", icon: "personas" },
] as const;
export type SettingsSection = (typeof sections)[number]["id"];

export function SettingsPage({
  api,
  settings,
  onChange,
  onDone,
  onResumeSetup,
  loadCatalog,
  initialSection = "repository",
}: AccountPageProps & { onResumeSetup?: () => void; initialSection?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [compact, setCompact] = useState(false);
  const id = useId();
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const descriptions = {
    repository: settings.repository?.branch ?? "Connect your code",
    models: settings.model.provider === "none" ? "Choose a provider" : modelProviderName(settings.model.provider),
    account: "Identity & setup",
  };

  return (
    <div className="settings-page">
      <PageHeader
        title="Settings"
        lede="Your code, your model access, your workspace."
        actions={onDone && <Button onClick={onDone}>Open workspace</Button>}
      />
      <div className="account-layout settings-layout">
        <aside className="account-layout-rail settings-rail">
          <div>
            <span className="account-label settings-rail-label">Workspace settings</span>
            <div
              className="settings-sections"
              role="tablist"
              aria-label="Settings sections"
              aria-orientation={compact ? "horizontal" : "vertical"}
            >
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
                          : ["ArrowRight", "ArrowDown"].includes(event.key)
                            ? (index + 1) % sections.length
                            : ["ArrowLeft", "ArrowUp"].includes(event.key)
                              ? (index + sections.length - 1) % sections.length
                              : undefined;
                    if (next === undefined) return;
                    event.preventDefault();
                    setSection(sections[next].id);
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
                  }}
                >
                  <Icon name={item.icon} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{descriptions[item.id]}</small>
                  </span>
                  <span className="settings-section-arrow" aria-hidden="true">
                    ›
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-rail-note">
            <Icon name="onboarding" />
            <p>
              Changes stay in your account.
              <br />
              Save each section when you’re ready.
            </p>
          </div>
        </aside>
        <div className="account-layout-content settings-content">
          {/* Keep the forms mounted so switching sections preserves unsaved input, including a newly entered key. */}
          <section
            role="tabpanel"
            id={`${id}-repository-panel`}
            aria-labelledby={`${id}-repository-tab`}
            hidden={section !== "repository"}
            tabIndex={0}
            className="settings-panel"
          >
            <header className="account-panel-heading">
              <span className="account-label">Source connection</span>
              <h2>Repository</h2>
              <p>Choose the code and branch this workspace follows.</p>
            </header>
            <RepositoryForm api={api} settings={settings} onChange={onChange} />
            <div className="account-panel-note">
              <Icon name="workspace" />
              <p>Connect now, decide what happens next. Code execution and deployment stay unconfigured.</p>
            </div>
          </section>
          <section
            role="tabpanel"
            id={`${id}-models-panel`}
            aria-labelledby={`${id}-models-tab`}
            hidden={section !== "models"}
            tabIndex={0}
            className="settings-panel"
          >
            <header className="account-panel-heading">
              <span className="account-label">Agent connection</span>
              <h2>Model access</h2>
              <p>Use your Not Organic account or connect a provider with your own key.</p>
            </header>
            <ModelAccessForm api={api} settings={settings} onChange={onChange} loadCatalog={loadCatalog} />
          </section>
          <section
            role="tabpanel"
            id={`${id}-account-panel`}
            aria-labelledby={`${id}-account-tab`}
            hidden={section !== "account"}
            tabIndex={0}
            className="settings-panel"
          >
            <header className="account-panel-heading">
              <span className="account-label">Identity & setup</span>
              <h2>Your account</h2>
              <p>Your repository connections, model access and documents belong to this identity.</p>
            </header>
            <div className="settings-identity">
              <span className="settings-identity-mark" aria-hidden="true">
                n.
              </span>
              <div>
                <strong>Not Organic</strong>
                <code>{settings.did}</code>
                <a href="/auth/login?setup=1">Sign in again to update account access</a>
              </div>
            </div>
            <div className="settings-readiness-heading">
              <h3>Workspace readiness</h3>
              <Tag>
                {
                  {
                    new: "Not started",
                    in_progress: "Setup in progress",
                    skipped: "Saved for later",
                    complete: "Setup complete",
                  }[settings.onboarding.status]
                }
              </Tag>
            </div>
            <SetupReview settings={settings} />
            {onResumeSetup && (
              <div className="account-actions">
                <Button onClick={onResumeSetup}>
                  {settings.onboarding.status === "complete" ? "Review setup" : "Resume setup"}
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
