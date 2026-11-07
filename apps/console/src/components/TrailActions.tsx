import { useState } from "react";
import { Button, Card, Field } from "../kit.ts";
import type { TrailAction } from "../api.ts";
import { describeError } from "../lib/errors.ts";
import "./TrailActions.css";

/** Comment, claim or release, park or resume. The caller decides what each does; this shows busy and failure states. */
export function TrailActions({ owned, parked, canAct = true, onAct }: {
  owned: boolean; parked: boolean; canAct?: boolean; onAct: (action: TrailAction, input: { text?: string; reason?: string }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (action: TrailAction, input: { text?: string; reason?: string } = {}) => {
    setBusy(action);
    setError(null);
    try { await onAct(action, input); if (action === "comment") setText(""); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const failure = error ? describeError(error) : null;
  return (
    <Card title="Act on this trail" tone="inset">
      <div className="trail-actions">
        <Field label="Comment" hint="Added to the timeline. Agents read it.">
          <textarea rows={2} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} disabled={!canAct} />
        </Field>
        <div className="trail-actions-row">
          <Button loading={busy === "comment"} disabled={!canAct || busy !== null || text.trim() === ""} onClick={() => void run("comment", { text: text.trim() })}>Comment</Button>
          <Button loading={busy === "claim" || busy === "release"} disabled={!canAct || busy !== null} onClick={() => void run(owned ? "release" : "claim")}>
            {owned ? "Release to agents" : "Claim for me"}
          </Button>
          <Button loading={busy === "park" || busy === "resume"} disabled={!canAct || busy !== null}
            onClick={() => void run(parked ? "resume" : "park", parked ? {} : { reason: text.trim() || "Parked from the console." })}>
            {parked ? "Resume" : "Park"}
          </Button>
        </div>
        {!canAct && <p className="muted">Only approvers can act on trails.</p>}
        {failure && <p role="alert"><strong>{failure.title}.</strong> {failure.body}</p>}
      </div>
    </Card>
  );
}
