import { JSONUIProvider, Renderer, useStateStore } from "@json-render/react";
import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "../kit.ts";
import { createRegistry, type FormHost } from "./registry.tsx";
import { readSpec, type FormState, type ReadSpec } from "./spec.ts";
import "./genui.css";

type Phase = "idle" | "working" | "applied" | "discarded";

/**
 * Renders a json-render spec from Velum. The spec is untrusted: it is validated against the catalog first, and a spec
 * that fails is replaced by a short note. The spec itself is never shown.
 */
export function SpecView({ spec, host, disabled }: { spec: unknown; host: FormHost; disabled?: boolean }) {
  const read = useMemo(() => readSpec(spec), [spec]);
  if (!read.ok) {
    return (
      <Card tone="alert" title="Velum sent a form this console cannot show">
        <p>Nothing was changed. You can ask Velum to try again, or edit the document directly.</p>
        <p className="muted">Reason: {read.reason}.</p>
      </Card>
    );
  }
  return <ValidForm read={read} host={host} disabled={disabled} />;
}

function ValidForm({ read, host, disabled }: { read: Extract<ReadSpec, { ok: true }>; host: FormHost; disabled?: boolean }) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const built = useMemo(() => createRegistry(hostRef), []);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const run = async (name: "apply_to_draft" | "ask_velum" | "discard", state: FormState) => {
    setError(null);
    if (name === "ask_velum") return built.executeAction(name, {}, () => undefined, state);
    setPhase("working");
    try {
      await built.executeAction(name, {}, () => undefined, state);
      setPhase(name === "apply_to_draft" ? "applied" : "discarded");
    } catch (e) {
      setPhase("idle");
      setError(e instanceof Error ? e.message : "Could not apply the form.");
    }
  };

  return (
    <JSONUIProvider registry={built.registry} initialState={read.state}>
      <div className="gu-form" data-phase={phase}>
        <Renderer spec={read.spec} registry={built.registry} />
        <FormActions phase={phase} error={error} disabled={disabled} run={run} />
      </div>
    </JSONUIProvider>
  );
}

function FormActions({ phase, error, disabled, run }: {
  phase: Phase; error: string | null; disabled?: boolean; run: (name: "apply_to_draft" | "ask_velum" | "discard", s: FormState) => Promise<void>;
}) {
  const { state } = useStateStore();
  if (phase === "applied") return <div className="gu-actions"><Badge tone="ok">Applied to the draft</Badge></div>;
  if (phase === "discarded") return <div className="gu-actions"><Badge>Form closed</Badge></div>;
  const busy = phase === "working";
  return (
    <div className="gu-actions">
      <Button variant="primary" loading={busy} disabled={disabled} onClick={() => void run("apply_to_draft", state)}>Apply to draft</Button>
      <Button variant="secondary" disabled={busy || disabled} onClick={() => void run("ask_velum", state)}>Ask Velum</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run("discard", state)}>Discard</Button>
      {error && <p role="alert" className="gu-error">{error}</p>}
    </div>
  );
}
