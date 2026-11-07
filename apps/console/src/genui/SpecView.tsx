import { JSONUIProvider, Renderer, useStateStore } from "@json-render/react";
import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "../kit.ts";
import { createRegistry, type FormContext, type FormHost } from "./registry.tsx";
import { collectValues, initialState, isEdited, readSpec, type FormField, type ReadSpec } from "./spec.ts";
import "./genui.css";

type Phase = "idle" | "working" | "applied" | "discarded";
type Name = "apply_to_draft" | "ask_velum" | "discard";

/**
 * Renders a json-render spec from Velum. The spec is untrusted: it is validated against the catalog first, and a spec that
 * fails is replaced by a short note. The spec itself is never shown.
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

function ValidForm({
  read,
  host,
  disabled,
}: {
  read: Extract<ReadSpec, { ok: true }>;
  host: FormHost;
  disabled?: boolean;
}) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const formRef = useRef<FormContext>({ values: () => ({}), edited: () => false });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const built = useMemo(
    () => createRegistry(hostRef, formRef, Boolean(disabled) || phase !== "idle"),
    [disabled, phase],
  );

  const run = async (name: Name) => {
    setError(null);
    if (name === "ask_velum") return built.executeAction(name, {}, () => undefined);
    setPhase("working");
    try {
      await built.executeAction(name, {}, () => undefined);
      setPhase(name === "apply_to_draft" ? "applied" : "discarded");
    } catch (e) {
      setPhase("idle");
      setError(e instanceof Error ? e.message : "Could not apply the form.");
    }
  };

  return (
    <JSONUIProvider registry={built.registry} initialState={initialState(read.fields)}>
      <div className="gu-form" data-phase={phase}>
        <Renderer spec={read.spec} registry={built.registry} />
        <FormActions
          phase={phase}
          error={error}
          disabled={disabled}
          fields={read.fields}
          formRef={formRef}
          run={run}
        />
      </div>
    </JSONUIProvider>
  );
}

function FormActions({
  phase,
  error,
  disabled,
  fields,
  formRef,
  run,
}: {
  phase: Phase;
  error: string | null;
  disabled?: boolean;
  fields: readonly FormField[];
  formRef: { current: FormContext };
  run: (n: Name) => Promise<void>;
}) {
  const { state } = useStateStore();
  formRef.current = { values: () => collectValues(fields, state), edited: () => isEdited(fields, state) };
  if (phase === "applied")
    return (
      <div className="gu-actions">
        <Badge tone="ok">Applied to the draft</Badge>
      </div>
    );
  if (phase === "discarded")
    return (
      <div className="gu-actions">
        <Badge>Form closed</Badge>
      </div>
    );
  const busy = phase === "working";
  return (
    <div className="gu-actions">
      <Button variant="primary" loading={busy} disabled={disabled} onClick={() => void run("apply_to_draft")}>
        Apply to draft
      </Button>
      <Button disabled={busy || disabled} onClick={() => void run("ask_velum")}>
        Ask Velum
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void run("discard")}>
        Discard
      </Button>
      {error && (
        <p role="alert" className="gu-error">
          {error}
        </p>
      )}
    </div>
  );
}
