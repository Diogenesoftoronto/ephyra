import { useEffect, useState } from "react";
import type { Draft } from "@ephyra/core";
import { Badge, Button, Card, Hash } from "../kit.ts";
import { describeError } from "../lib/errors.ts";
import { clockTime } from "../lib/format.ts";
import { hasBlocking } from "../lib/warnings.ts";
import "./PublishBar.css";

/**
 * Apply, then publish. Publishing writes a commit to the draft's policy ref; it does not change the policy in effect until
 * that commit lands. Only approvers publish. A 409 means the live document moved or the draft has errors.
 */
export function PublishBar({
  draft,
  canPublish = true,
  onPublish,
  onDiscard,
  onStartOver,
  unsaved,
}: {
  draft: Draft;
  canPublish?: boolean;
  onPublish: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onStartOver?: () => void;
  unsaved?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"publish" | "discard" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const blocked = hasBlocking(draft.warnings);
  useEffect(() => setConfirm(false), [draft.content, unsaved]);
  const run = async (what: "publish" | "discard", fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      setConfirm(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const failure = error ? describeError(error) : null;

  if (draft.status === "published" && draft.published) {
    return (
      <Card tone="quiet" title="Published">
        <dl className="publish-facts">
          <div>
            <dt>Ref</dt>
            <dd className="mono">{draft.published.ref}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>
              <Hash value={draft.published.commit} chars={10} />
            </dd>
          </div>
          <div>
            <dt>By</dt>
            <dd className="mono">{draft.published.by}</dd>
          </div>
          <div>
            <dt>At</dt>
            <dd>
              {draft.published.at.slice(0, 10)} {clockTime(draft.published.at)}
            </dd>
          </div>
        </dl>
        <p className="muted">
          The policy in effect changes when this commit lands on the base ref, through the same landing as
          trails.
        </p>
      </Card>
    );
  }
  if (draft.status === "discarded")
    return (
      <Card tone="quiet">
        <Badge>Discarded</Badge> <span className="muted">This draft was closed without publishing.</span>
      </Card>
    );

  return (
    <Card tone={failure?.kind === "stale" ? "alert" : "tray"} title="Publish">
      <div className="publish">
        {failure?.kind === "stale" ? (
          <div role="alert" className="publish-conflict">
            <strong>Publishing was refused.</strong>
            <span>
              {error instanceof Error && "detail" in error && typeof error.detail === "string"
                ? error.detail
                : failure.body}{" "}
              Your text is still here.
            </span>
            <div className="publish-row">
              {onStartOver && (
                <Button onClick={onStartOver}>Start a new draft from the current policy</Button>
              )}
              <Button variant="ghost" onClick={() => setError(null)}>
                Keep editing
              </Button>
            </div>
          </div>
        ) : failure ? (
          <p role="alert">
            <strong>{failure.title}.</strong> {failure.body}
          </p>
        ) : null}
        {unsaved && <p role="status">Save or discard your edits before publishing this draft.</p>}
        {blocked && (
          <p>
            <Badge tone="bad">Parser errors</Badge> Fix them before publishing.
          </p>
        )}
        {!canPublish && <p className="muted">Only approvers can edit or publish. This draft is read only.</p>}
        {confirm ? (
          <div className="publish-confirm">
            <p>
              This writes a commit to <span className="mono">refs/ephyra/policy/{draft.id}</span> with your
              name on it. Nothing changes in production until it lands.
            </p>
            <div className="publish-row">
              <Button
                variant="primary"
                loading={busy === "publish"}
                disabled={!canPublish || blocked || unsaved || busy !== null}
                onClick={() => void run("publish", onPublish)}
              >
                Yes, publish
              </Button>
              <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirm(false)}>
                Not yet
              </Button>
            </div>
          </div>
        ) : (
          <div className="publish-row">
            <Button
              variant="primary"
              disabled={!canPublish || blocked || unsaved || busy !== null}
              onClick={() => setConfirm(true)}
            >
              Publish…
            </Button>
            <Button
              variant="ghost"
              loading={busy === "discard"}
              disabled={!canPublish || busy !== null}
              onClick={() => void run("discard", onDiscard)}
            >
              Discard draft
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
