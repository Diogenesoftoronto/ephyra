import { useState } from "react";
import { Button, Field } from "../kit.ts";
import type { Verdict } from "../api.ts";
import { HoldButton } from "./HoldButton.tsx";
import "./CheckpointCard.css";

/** Busy and failure state around one decision call. The caller shows the failure; the form shows busy. */
export function useDecision(onDecide?: (verdict: Verdict, note: string) => Promise<void>) {
  const [busy, setBusy] = useState<Verdict | null>(null);
  const [error, setError] = useState<unknown>(null);
  const submit = async (verdict: Verdict, note: string) => {
    setBusy(verdict);
    setError(null);
    try {
      await onDecide?.(verdict, note.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, submit };
}

/**
 * Approve, ask for changes, or reject, with a note. Revise and reject need a note; approve does not, so on a touchscreen
 * approve is a press-and-hold instead (a click or the keyboard still acts at once).
 */
export function DecisionForm({
  busy,
  disabled,
  onSubmit,
  approveLabel = "Approve",
}: {
  busy: Verdict | null;
  disabled?: boolean;
  onSubmit: (verdict: Verdict, note: string) => void;
  approveLabel?: string;
}) {
  const [note, setNote] = useState("");
  const noNote = note.trim() === "";
  return (
    <div className="decision">
      <Field label="Note" hint="Required for changes and reject. Optional for approve.">
        <textarea
          rows={2}
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          disabled={disabled}
        />
      </Field>
      <div className="cp-actions">
        <HoldButton
          variant="primary"
          loading={busy === "approve"}
          disabled={disabled || busy !== null}
          holdLabel={`Hold to ${approveLabel.toLowerCase()}`}
          onConfirm={() => onSubmit("approve", note)}
        >
          {approveLabel}
        </HoldButton>
        <Button
          loading={busy === "revise"}
          disabled={disabled || busy !== null || noNote}
          onClick={() => onSubmit("revise", note)}
        >
          Ask for changes
        </Button>
        <Button
          variant="danger"
          loading={busy === "reject"}
          disabled={disabled || busy !== null || noNote}
          onClick={() => onSubmit("reject", note)}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
