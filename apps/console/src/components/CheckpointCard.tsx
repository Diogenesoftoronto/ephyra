import type { Decision } from "@ephyra/core";
import { Badge, Button, Card, Checkpoint, Hash } from "../kit.ts";
import type { InboxEntry, Verdict } from "../api.ts";
import { describeError } from "../lib/errors.ts";
import { clockTime } from "../lib/format.ts";
import { DecisionForm, useDecision } from "./DecisionForm.tsx";
import "./CheckpointCard.css";

export const CHECKPOINT_NAME = { A: "Hypothesis", B: "Plan", C: "Landing" } as const;
export type Bound = InboxEntry["bound"];

/**
 * Why a card's approval would be refused. The server refuses a decision when the head or the proof digest changed since the
 * item was made. Any different revision, head or proof digest requires a new review.
 */
export function staleness(
  bound: Bound,
  now: { rev: number; head?: string; proofDigest?: string },
): string | null {
  if ((now.head ?? null) !== (bound.head ?? null))
    return `The head commit changed since this was made (revision ${bound.rev} to ${now.rev}).`;
  if (now.rev !== bound.rev) return `The revision changed from ${bound.rev} to ${now.rev}.`;
  if (now.proofDigest !== bound.proofDigest) return "The proof digest changed since this review was created.";
  return null;
}

type Props = {
  checkpoint: "A" | "B" | "C";
  /** The open item for this checkpoint, if one is waiting. */
  item?: InboxEntry;
  /** The recorded decision, if one was made. */
  decision?: Decision;
  /** Why the card's binding no longer matches the trail, if it does. */
  stale?: string | null;
  /** True when this person may decide. False shows why the buttons are off. */
  canDecide?: boolean;
  unavailableReason?: string;
  onDecide?: (verdict: Verdict, note: string) => Promise<void>;
  onReload?: () => void;
};

/**
 * One checkpoint of a trail. A waiting checkpoint shows the revision, head and proof digest the approval is bound to,
 * and approves, revises or rejects with a note. A stale or already decided checkpoint cannot be approved.
 */
export function CheckpointCard({
  checkpoint,
  item,
  decision,
  stale,
  canDecide = true,
  unavailableReason,
  onDecide,
  onReload,
}: Props) {
  const { busy, error, submit } = useDecision(onDecide);
  const title = <Checkpoint id={checkpoint} blocking={item?.blocking && !decision} />;

  if (decision) {
    return (
      <Card title={title} tone="quiet" meta={<>Decided {clockTime(decision.at)}</>}>
        <div className="cp-decided">
          <Badge
            tone={decision.verdict === "approve" ? "ok" : decision.verdict === "revise" ? "warn" : "bad"}
          >
            {decision.verdict}
          </Badge>
          <span>by {decision.by === "policy" ? "policy" : (decision.who ?? "a person")}</span>
          {decision.shadow && <Badge>shadow</Badge>}
          {decision.backend && <span className="mono muted">{decision.backend}</span>}
        </div>
        {decision.note && <p className="cp-note">“{decision.note}”</p>}
      </Card>
    );
  }
  if (!item)
    return (
      <Card title={title} tone="quiet">
        <p className="muted">Not reached yet.</p>
      </Card>
    );

  const failure = error ? describeError(error) : null;
  const off = !canDecide || Boolean(stale) || failure?.kind === "stale";

  return (
    <Card
      title={title}
      tone={stale || failure?.kind === "stale" ? "alert" : "tray"}
      meta={
        <>
          {item.blocking
            ? "Blocking: the quest waits for you."
            : "Advisory: the quest carries on without you."}
        </>
      }
    >
      <p className="cp-summary">{item.artefact.summary}</p>
      <dl className="cp-bound" aria-label="What this approval is bound to">
        <div>
          <dt>Revision</dt>
          <dd className="num">{item.bound.rev}</dd>
        </div>
        <div>
          <dt>Head</dt>
          <dd>
            {item.bound.head ? (
              <Hash value={item.bound.head} chars={10} />
            ) : (
              <span className="muted">none yet</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Proof digest</dt>
          <dd>
            {item.bound.proofDigest ? (
              <Hash value={item.bound.proofDigest} chars={10} />
            ) : (
              <span className="muted">no proof</span>
            )}
          </dd>
        </div>
      </dl>
      {item.shadowVerdict && (
        <p className="muted">
          Policy in shadow mode would <strong>{item.shadowVerdict}</strong> this.
        </p>
      )}
      {(stale || failure?.kind === "stale") && (
        <div className="cp-stale" role="alert">
          <strong>This approval is stale.</strong>
          <span>
            {stale ?? "The quest changed after you opened this."} Nothing was recorded. Read the new version,
            then decide.
          </span>
          {onReload && (
            <Button size="sm" onClick={onReload}>
              Reload this quest
            </Button>
          )}
        </div>
      )}
      {failure && failure.kind !== "stale" && (
        <p role="alert" className="cp-error">
          <strong>{failure.title}.</strong> {failure.body}
        </p>
      )}
      {!canDecide && <p className="muted">{unavailableReason ?? "Only approvers can decide. You can read everything here."}</p>}
      <DecisionForm
        approveLabel={`Approve ${CHECKPOINT_NAME[checkpoint].toLowerCase()}`}
        busy={busy}
        disabled={off}
        onSubmit={(v, n) => void submit(v, n)}
      />
    </Card>
  );
}
