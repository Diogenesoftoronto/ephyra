import { useEffect, useRef, useState } from "react";
import { Button } from "../kit.ts";
import {
  AccountSaveFeedback,
  ModelAccessForm,
  RepositoryForm,
  SetupReview,
  type AccountPageProps,
} from "../components/AccountForms.tsx";
import { useAccountWrite } from "../components/useAccountWrite.ts";
import "./OnboardingPage.css";

const steps = ["Repository", "Model access", "Review"];
const titles = ["Connect your repository", "Choose model access", "Review your setup"];

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
    <div className="account-page onboarding-page">
      <header className="ui-page-header">
        <h1 ref={heading} tabIndex={-1}>
          {titles[step]}
        </h1>
        <Button variant="ghost" disabled={locked} onClick={() => void finish("skip")} data-account-action="skip-setup">
          Explore first
        </Button>
      </header>
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
      <div className="onboarding-content">
        {step === 0 ? (
          <RepositoryForm
            api={api}
            settings={settings}
            onChange={onChange}
            onDone={() => setStep(1)}
            onBusyChange={setFormBusy}
            secondaryAction={
              <Button variant="ghost" disabled={locked} onClick={() => setStep(1)}>
                Skip repository
              </Button>
            }
          />
        ) : step === 1 ? (
          <ModelAccessForm
            api={api}
            settings={settings}
            onChange={onChange}
            onDone={() => setStep(2)}
            onBusyChange={setFormBusy}
            loadCatalog={loadCatalog}
            secondaryAction={
              <Button variant="ghost" disabled={locked} onClick={() => setStep(0)}>
                Back
              </Button>
            }
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
              <Button variant="ghost" disabled={locked} onClick={() => setStep(1)}>
                Back
              </Button>
            </div>
          </>
        )}
        <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      </div>
    </div>
  );
}
