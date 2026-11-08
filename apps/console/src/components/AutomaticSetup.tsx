import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SetupMode, SetupRun } from "@ephyra/core";
import type { SetupApi } from "../setup-api.ts";
import { Button, Tag } from "../kit.ts";
import { browserSetupStore, SetupController } from "./setup-controller.ts";
import { BootstrapCoverage } from "./BootstrapSetup.tsx";

export function SetupModeChoice({ value, onChange, disabled }: {
  value: SetupMode; onChange: (mode: SetupMode) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="account-fields setup-mode" disabled={disabled}>
      <legend>How Ephyra should work</legend>
      <label className="setup-mode-choice" data-selected={value === "autonomous" || undefined}>
        <input type="radio" name="setup-mode" checked={value === "autonomous"} onChange={() => onChange("autonomous")} />
        <span><strong>Self-driving</strong><small>Investigate and resolve within the configured policy. Ask when something needs you.</small></span>
      </label>
      <label className="setup-mode-choice" data-selected={value === "supervised" || undefined}>
        <input type="radio" name="setup-mode" checked={value === "supervised"} onChange={() => onChange("supervised")} />
        <span><strong>Supervised</strong><small>Pause for your review at the configured checkpoints.</small></span>
      </label>
    </fieldset>
  );
}

const statusNames: Record<SetupRun["status"], string> = {
  queued: "Setup queued", running: "Setting up your application", blocked: "Setup needs a connection",
  ready: "Setup ready", failed: "Setup could not finish",
};

export function SetupProgress({ run }: { run: SetupRun }) {
  return (
    <div className="automatic-setup">
      <div className="account-saved" role="status">
        <h2>{run.investigationActive && run.status === "blocked" ? "Investigation active · landing needs a connection" : statusNames[run.status]}</h2>
        <Tag>{run.mode === "autonomous" ? "Self-driving" : "Supervised"}</Tag>
      </div>
      <p className="account-hint">
        {run.repository.branch} · <code>{run.repository.head.slice(0, 12)}</code>
      </p>
      {run.investigationActive && <p className="account-hint">
        Ephyra can investigate signals in this workspace.
        {run.blockers.length > 0 && " The remaining blockers below limit later steps such as landing or watching a change."}
      </p>}
      {run.bootstrap && <section className="bootstrap-setup-summary" aria-label="Application observation coverage">
        <h3>What Ephyra can see</h3>
        <BootstrapCoverage assessment={run.bootstrap} compact />
        <p className="account-hint">{run.bootstrap.requests.filter((request) => request.status === "open").length} setup requests are waiting.</p>
        <a href="#/inbox">Answer setup questions in your inbox</a>
      </section>}
      <ol className="setup-progress" aria-label="Automatic setup progress">
        {run.steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <span className="setup-step-marker" aria-hidden="true">{step.status === "complete" ? "✓" : "·"}</span>
            <div><strong>{step.name}</strong><p>{step.detail}</p></div>
            <span className="setup-step-status">{step.status}</span>
          </li>
        ))}
      </ol>
      {run.blockers.length > 0 && (
        <section className="setup-blockers" aria-label="What can unblock setup">
          <h3>What can unblock this</h3>
          {run.blockers.map((blocker) => (
            <div key={blocker.id} className="account-feedback" data-tone="warning">
              <strong>{blocker.summary}</strong>
              <p>{blocker.action}</p>
              <span className="account-hint">For the {blocker.owner === "operator" ? "deployment operator" : "repository maintainer"}</span>
            </div>
          ))}
        </section>
      )}
      {run.artifacts.length > 0 && (
        <details className="account-advanced setup-artifacts">
          <summary>Inspect setup documents ({run.artifacts.length})</summary>
          <p className="account-hint">Generated configuration and the evidence used to prepare it.</p>
          {run.artifacts.map((artifact) => (
            <details key={artifact.path}>
              <summary><code>{artifact.path}</code></summary>
              <pre>{artifact.content}</pre>
              <p className="account-hint">Digest <code>{artifact.digest}</code></p>
            </details>
          ))}
          {run.policyRef && <p className="account-hint">Recorded at <code>{run.policyRef}</code></p>}
        </details>
      )}
      <div className="setup-inspect-links">
        <a href="#/runs">Inspect agent runs</a>
        <a href="#/workspace">Open autonomy documents</a>
        <a href="#/inbox">See requests for help</a>
      </div>
    </div>
  );
}

export function AutomaticSetup({ api, account, workspace, initialMode, onOpen }: {
  api: SetupApi; account: string; workspace: string; initialMode: SetupMode;
  onOpen: (ready: boolean) => void;
}) {
  const controller = useMemo(() => new SetupController(api, browserSetupStore(account, workspace)), [api, account, workspace]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [mode, setMode] = useState(initialMode);
  useEffect(() => { void controller.load(initialMode); }, [controller, initialMode]);
  useEffect(() => { if (state.run) setMode(state.run.mode); }, [state.run?.id]);
  const running = state.run?.status === "queued" || state.run?.status === "running";
  useEffect(() => {
    if (!running && !state.uncertain) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void controller.refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [controller, running, state.uncertain]);
  return (
    <>
      {state.run ? <SetupProgress run={state.run} /> : (
        <p role="status" className="account-hint">{state.busy ? "Reading setup progress…" : "Preparing automatic setup."}</p>
      )}
      {state.uncertain && (
        <div className="account-feedback" data-tone="warning" role="status">
          <strong>Checking whether setup started</strong>
          <p>The response was interrupted. Ephyra is reading the saved run before allowing another start.</p>
          <Button disabled={state.busy} onClick={() => void controller.refresh()}>Check saved progress</Button>
        </div>
      )}
      {state.error && (
        <div className="account-feedback" data-tone="warning" role="alert">
          <p>{state.error}</p>
          <Button disabled={state.busy} onClick={() => void controller.refresh()}>Refresh progress</Button>
        </div>
      )}
      <details className="account-advanced">
        <summary>Automation preferences</summary>
        <SetupModeChoice value={mode} onChange={setMode} disabled={running || state.busy || state.uncertain} />
      </details>
      <div className="account-actions">
        <Button variant="primary" onClick={() => onOpen(state.run?.status === "ready")} data-account-action="finish-setup">
          Open workspace
        </Button>
        {!running && !state.uncertain && (
          <Button disabled={state.busy} onClick={() => void controller.start(mode)}>
            {state.run && state.run.mode !== mode ? "Apply automation preference" : state.run ? "Recheck setup" : "Start setup"}
          </Button>
        )}
      </div>
      {running && <p className="account-hint">You can leave this page. Setup continues on the server.</p>}
    </>
  );
}
