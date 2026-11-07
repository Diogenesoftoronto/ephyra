import { Card, PageHeader, Button } from "../kit.ts";
import { ModelAccessForm, RepositoryForm, SetupReview, type AccountPageProps } from "../components/AccountForms.tsx";
import "./SettingsPage.css";

export function SettingsPage({
  api,
  settings,
  onChange,
  onDone,
  onResumeSetup,
  loadCatalog,
}: AccountPageProps & { onResumeSetup?: () => void }) {
  return (
    <div className="settings-page">
      <PageHeader
        title="Settings"
        lede="Connect your repository and choose how agents access models."
        actions={onDone && <Button onClick={onDone}>Open workspace</Button>}
      />
      <Card
        title="Your account"
        className="settings-identity"
        actions={
          onResumeSetup && (
            <Button size="sm" onClick={onResumeSetup}>
              {settings.onboarding.status === "complete" ? "Review setup" : "Resume setup"}
            </Button>
          )
        }
      >
        <div>
          <span className="account-label">Not Organic identity</span>
          <code>{settings.did}</code>
          <a href="/auth/login?setup=1">Sign in again to update account access</a>
        </div>
      </Card>
      <div className="settings-connections">
        <Card title="Repository" meta="Source for this workspace">
          <RepositoryForm api={api} settings={settings} onChange={onChange} />
        </Card>
        <Card title="Model access" meta="Your account or your own key">
          <ModelAccessForm api={api} settings={settings} onChange={onChange} loadCatalog={loadCatalog} />
        </Card>
      </div>
      <Card title="What is ready" tone="quiet">
        <SetupReview settings={settings} />
      </Card>
    </div>
  );
}
