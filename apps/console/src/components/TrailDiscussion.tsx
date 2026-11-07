import { useEffect, useState } from "react";
import type { TrailEvent } from "@ephyra/core";
import { Badge, Button, Field } from "../kit.ts";
import { clockTime } from "../lib/format.ts";
import { describeError } from "../lib/errors.ts";
import { UnknownWriteOutcome } from "../api.ts";
import "./TrailDiscussion.css";

export type TrailConnectionStatus = "connecting" | "live" | "disconnected" | "reconnecting" | "error";
const CONNECTION: Record<TrailConnectionStatus, string> = {
  connecting: "Connecting to shared updates",
  live: "Shared updates connected",
  disconnected: "Updates paused",
  reconnecting: "Reconnecting to shared updates",
  error: "Shared updates unavailable",
};
type DiscussionEvent = Extract<TrailEvent, { type: "human_comment" | "claimed_by_human" | "released_by_human" }>;

/** Recorded authors and comments. The parent owns the draft and mutation key; updates never replace the composer. */
export function TrailDiscussion({
  events,
  principal,
  draft,
  onDraftChange,
  onComment,
  canComment = true,
  status = "live",
  busy = false,
  error,
  unconfirmed = false,
  onReconcile,
}: {
  events: TrailEvent[];
  principal?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onComment: (text: string) => Promise<void>;
  canComment?: boolean;
  status?: TrailConnectionStatus;
  busy?: boolean;
  error?: unknown;
  unconfirmed?: boolean;
  onReconcile?: () => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState<unknown>(null);
  useEffect(() => {
    if (!unconfirmed) setLocalError((current: unknown) => current instanceof UnknownWriteOutcome ? null : current);
  }, [unconfirmed]);
  const failure = error || localError ? describeError(error || localError) : null;
  const unknownOutcome = unconfirmed || failure?.kind === "unknown-outcome";
  const working = busy || sending || checking;
  const entries = events.filter((event): event is DiscussionEvent =>
    event.type === "human_comment" || event.type === "claimed_by_human" || event.type === "released_by_human",
  );
  const connected = status === "live";
  const send = async () => {
    if (!canComment || !connected || working || unknownOutcome || !draft.trim()) return;
    setSending(true);
    setLocalError(null);
    try {
      await onComment(draft.trim());
    } catch (e) {
      setLocalError(e);
    } finally {
      setSending(false);
    }
  };
  const reconcile = async () => {
    if (!onReconcile || working) return;
    setChecking(true);
    setLocalError(null);
    try {
      await onReconcile();
    } catch (e) {
      setLocalError(e);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="trail-discussion" aria-label="Shared trail discussion">
      <header className="trail-discussion-head">
        <h2>Discussion</h2>
        <span className="trail-discussion-connection" data-state={status} role="status">
          {CONNECTION[status]}
        </span>
      </header>
      <p className="trail-discussion-intro">Notes and review handoffs stay with this trail.</p>
      {entries.length ? (
        <ol className="trail-discussion-messages" aria-label="Comments and review handoffs">
          {entries.map((event) => (
            <li key={event.id} className="trail-discussion-message" data-event-id={event.id}>
              <header>
                <b>{event.actor.id}</b>
                {event.actor.id === principal && <Badge>You</Badge>}
                <time dateTime={event.at} title={event.at}>
                  {event.at.slice(0, 10)} · {clockTime(event.at)}
                </time>
              </header>
              {event.type === "human_comment" ? <p>{event.data.text}</p> : (
                <p className="trail-discussion-handoff">
                  {event.type === "claimed_by_human" ? "Claimed the checkpoint review." : "Released the checkpoint review."}
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : <p className="trail-discussion-empty">No comments yet. Leave the next reviewer a question or useful context.</p>}
      <span className="sr-only" role="status">{entries.length} recorded discussion entries.</span>
      <form className="trail-discussion-compose" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Field label="Comment on this trail" hint="Shared with everyone who can read this trail. Up to 4,000 characters.">
          <textarea
            rows={3}
            value={draft}
            maxLength={4000}
            onChange={(event) => { onDraftChange(event.target.value); if (!unknownOutcome) setLocalError(null); }}
            disabled={!canComment}
          />
        </Field>
        <div className="trail-discussion-send">
          <Button
            type="submit"
            variant="primary"
            loading={busy || sending}
            disabled={!canComment || !connected || working || unknownOutcome || !draft.trim()}
          >
            Add comment
          </Button>
          {!canComment ? <p>Only approvers can add comments.</p>
            : !connected ? <p>Your draft stays here while the connection recovers.</p> : null}
        </div>
      </form>
      {unknownOutcome ? (
        <div className="trail-discussion-feedback" role="status">
          <p><strong>Change outcome unconfirmed.</strong> Check delivery before sending another comment.</p>
          {onReconcile && <Button loading={checking} disabled={working} onClick={() => void reconcile()}>Check delivery</Button>}
        </div>
      ) : failure ? (
        <p className="trail-discussion-feedback" role="alert"><strong>{failure.title}.</strong> {failure.body}</p>
      ) : null}
    </section>
  );
}
