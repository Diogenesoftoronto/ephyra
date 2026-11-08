import { useEffect, useState } from "react";
import type { Trail } from "@ephyra/core";
import { Button, Card } from "../kit.ts";
import type { TrailAction } from "../api.ts";
import { describeError } from "../lib/errors.ts";
import "./TrailActions.css";

/** Checkpoint review ownership. Claiming a review does not promise to stop or start an agent process. */
export function TrailActions({
  principal,
  owner,
  ownerUnknown = false,
  parked,
  canAct = true,
  canClaim = false,
  blocked = false,
  onAct,
}: {
  principal?: string;
  owner?: Trail["owner"];
  ownerUnknown?: boolean;
  parked: boolean;
  canAct?: boolean;
  canClaim?: boolean;
  blocked?: boolean;
  onAct: (action: TrailAction, input: { text?: string; reason?: string }) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const humanOwner = owner?.kind === "human" ? owner.id : undefined;
  const mine = !!principal && humanOwner === principal;
  const otherOwner = !!humanOwner && !mine;
  const failure = error ? describeError(error) : null;
  const unavailable = !canAct || !principal || ownerUnknown || busy !== null || blocked || failure?.kind === "unknown-outcome";
  useEffect(() => { if (!blocked) setError(null); }, [blocked]);
  const run = async (action: TrailAction, input: { text?: string; reason?: string } = {}) => {
    if (unavailable || otherOwner || (action === "claim" && !canClaim)) return;
    setBusy(action);
    setError(null);
    try {
      await onAct(action, input);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Review ownership" tone="quiet">
      <div className="trail-actions">
        <p className="trail-actions-owner">
          {humanOwner ? <><strong>{mine ? "You hold this review" : "Review claimed"}.</strong> <span>{humanOwner}</span></>
            : ownerUnknown ? "This older handoff has no recorded owner." : "No reviewer has claimed this quest."}
        </p>
        <div className="trail-actions-row">
          <Button
            loading={busy === "claim" || busy === "release"}
            disabled={unavailable || otherOwner || (!mine && !canClaim)}
            onClick={() => void run(mine ? "release" : "claim")}
          >
            {mine ? "Release review" : "Claim review"}
          </Button>
          <Button
            loading={busy === "park" || busy === "resume"}
            disabled={unavailable || otherOwner || mine}
            onClick={() =>
              void run(
                parked ? "resume" : "park",
                parked ? {} : { reason: "Parked from the console." },
              )
            }
          >
            {parked ? "Resume quest" : "Park quest"}
          </Button>
        </div>
        {ownerUnknown ? <p className="muted">An operator must reconcile this handoff before the workflow can continue.</p>
          : humanOwner ? <p className="muted">Only the owner can release this review. Comments remain shared.</p>
          : !canClaim && <p className="muted">Review claims are available while waiting at a checkpoint.</p>}
        {mine && <p className="muted">Release the review to make the checkpoint decision available again.</p>}
        {!canAct && <p className="muted">Only approvers can act on quests.</p>}
        {failure && (
          <p role="alert">
            <strong>{failure.title}.</strong> {failure.body}
          </p>
        )}
      </div>
    </Card>
  );
}
