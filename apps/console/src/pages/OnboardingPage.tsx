import { useEffect, useRef, useState } from "react";
import { Button, Icon, PageHeader } from "../kit.ts";
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
const stepHints = ["Connect your code", "Choose how agents work", "Open your workspace"];

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
        lede="Connect your code and choose model access. You can finish setup later."
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
      <div className="account-layout onboarding-layout">
        <aside className="account-layout-rail onboarding-rail">
          <div>
            <span className="account-label onboarding-rail-label">Your starting point</span>
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
                      <span>
                        <strong>{label}</strong>
                        <small>{stepHints[index]}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          </div>
          <div className="onboarding-guide">
            <div className="onboarding-guide-heading">
              <PersonaAvatar persona="velum" size={32} />
              <strong>Start with intent.</strong>
            </div>
            <p className="account-hint">
              Tell Ephyra what matters. With model access, Velum can help you draft your intent.
            </p>
          </div>
          <div className="onboarding-identity">
            <Icon name="onboarding" />
            <span>Signed in · Not Organic</span>
          </div>
        </aside>
        <section className="account-layout-content onboarding-content">
          <header className="account-panel-heading">
            <span className="account-label">Step {step + 1} of 3</span>
            <h2 ref={heading} tabIndex={-1}>
              {step === 0
                ? "Where does your code live?"
                : step === 1
                  ? "How should agents access models?"
                  : "Ready to open your workspace"}
            </h2>
            <p>
              {step === 0
                ? "Ephyra checks the branch before connecting it to this account."
                : step === 1
                  ? "Bring your own key or use your Not Organic account. You can also decide later."
                  : "These are your saved settings. You can change them any time in Settings."}
            </p>
          </header>
          {settings.onboarding.status === "skipped" && (
            <p className="onboarding-resumed">Pick up where you left off. Your saved connections are still here.</p>
          )}
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
          <div className="onboarding-footer">
            {step > 0 && (
              <Button variant="ghost" disabled={locked} onClick={() => setStep(step - 1)}>
                <span aria-hidden="true">←</span> Back to {steps[step - 1]?.toLowerCase()}
              </Button>
            )}
            <span className="account-hint">No paid model requests during setup.</span>
          </div>
        </section>
      </div>
    </div>
  );
}
