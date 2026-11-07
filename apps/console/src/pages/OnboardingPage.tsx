import { useEffect, useRef, useState } from "react";
import { Button, Card, PageHeader } from "../kit.ts";
import {
  AccountSaveFeedback,
  ModelAccessForm,
  RepositoryForm,
  SetupReview,
  type AccountPageProps,
} from "../components/AccountForms.tsx";
import { useAccountWrite } from "../components/useAccountWrite.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import "./OnboardingPage.css";

const steps = ["Repository", "Model access", "Review"];

export function OnboardingPage({ api, settings, onChange, onDone, loadCatalog }: AccountPageProps) {
  const [step, setStep] = useState(() => (settings.repository ? (settings.model.provider === "none" ? 1 : 2) : 0));
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const write = useAccountWrite(api, onChange);
  const [formBusy, setFormBusy] = useState(false);
  const locked = write.locked || formBusy;
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus();
    previousStep.current = step;
  }, [step]);
  async function finish(action: "skip" | "complete") {
    const persistedAction = action === "complete" && !settings.repository ? "skip" : action;
    const next = await write.save(
      { expectedVersion: settings.version, action: persistedAction },
      (value, key) => api.onboarding(value, key),
      persistedAction === "skip" ? "Setup saved for later." : "Setup saved.",
    );
    if (next) onDone?.();
  }

  return (
    <div className="onboarding-page">
      <PageHeader
        title="Make this workspace yours"
        lede="Connect your code, choose model access, then start with your intent and autonomy policy."
        actions={
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => void finish("skip")}
            data-account-action="skip-setup"
          >
            Explore first
          </Button>
        }
      />
      <nav aria-label="Setup progress">
        <ol className="onboarding-steps">
          {steps.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                aria-current={step === index ? "step" : undefined}
                disabled={locked}
                onClick={() => setStep(index)}
              >
                <span className="onboarding-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {settings.onboarding.status === "skipped" && (
        <p className="account-hint">You can pick up where you left off. Your saved connections are shown below.</p>
      )}
      <div className="onboarding-layout">
        <Card className="onboarding-content">
          <div className="onboarding-section-heading">
            <span className="account-label">Step {step + 1} of 3</span>
            <h2 ref={heading} tabIndex={-1}>
              {step === 0
                ? "Where does your code live?"
                : step === 1
                  ? "How should agents access models?"
                  : "Ready to open your workspace"}
            </h2>
            <p className="account-hint">
              {step === 0
                ? "Ephyra checks the branch before connecting it to this account."
                : step === 1
                  ? "Bring your own key or use your Not Organic account. You can also decide later."
                  : "These are your saved settings. You can change them any time in Settings."}
            </p>
          </div>
          {step === 0 ? (
            <>
              <RepositoryForm
                api={api}
                settings={settings}
                onChange={onChange}
                onDone={() => setStep(1)}
                onBusyChange={setFormBusy}
              />
              <Button variant="ghost" disabled={locked} onClick={() => setStep(1)}>
                I'll connect a repository later
              </Button>
            </>
          ) : step === 1 ? (
            <ModelAccessForm
              api={api}
              settings={settings}
              onChange={onChange}
              onDone={() => setStep(2)}
              onBusyChange={setFormBusy}
              loadCatalog={loadCatalog}
            />
          ) : (
            <>
              <SetupReview settings={settings} />
              <div className="account-actions">
                <Button
                  variant="primary"
                  loading={write.busy}
                  disabled={locked}
                  onClick={() => void finish("complete")}
                  data-account-action="finish-setup"
                >
                  Open workspace
                </Button>
              </div>
            </>
          )}
          <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
          {step > 0 && (
            <Button variant="ghost" disabled={locked} onClick={() => setStep(step - 1)}>
              Back to {steps[step - 1]?.toLowerCase()}
            </Button>
          )}
        </Card>
        <aside className="onboarding-aside">
          <div className="onboarding-guide">
            <PersonaAvatar persona="velum" size={48} />
            <div>
              <strong>Start with your intent</strong>
              <p className="account-hint">
                Write what your application should do and where it needs your approval. When model access is ready,
                Velum can help you draft it.
              </p>
            </div>
          </div>
          <div className="onboarding-note">
            <span className="account-label">You stay in control</span>
            <p>
              Connecting a repository does not start code execution or deployment. Autonomous execution is not
              configured.
            </p>
            <p className="account-hint">No paid model request runs during setup.</p>
          </div>
          <div className="onboarding-identity">
            <span className="account-label">Signed in as</span>
            <code>{settings.did}</code>
          </div>
        </aside>
      </div>
    </div>
  );
}
