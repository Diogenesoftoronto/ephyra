import { useEffect, useState } from "react";
import type { Draft } from "@ephyra/core";
import { Badge, Button, Card, Hash } from "../kit.ts";
import { describeError } from "../lib/errors.ts";
import { clockTime } from "../lib/format.ts";
import { hasBlocking } from "../lib/warnings.ts";
import type { PolicyActivationControls } from "../app/policyActivationSession.ts";
import "./PublishBar.css";

/**
 * Publication preserves a reviewed commit. A separate approver action activates the exact document in this workspace.
 */
export function PublishBar({
  draft,
  canPublish = true,
  onPublish,
  onDiscard,
  onStartOver,
  unsaved,
  activation,
}: {
  draft: Draft;
  canPublish?: boolean;
  onPublish: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onStartOver?: () => void;
  unsaved?: boolean;
  activation?: PolicyActivationControls;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"publish" | "discard" | "activate" | "check" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const blocked = hasBlocking(draft.warnings);
  useEffect(() => setConfirm(false), [draft.content, unsaved]);
  const run = async (what: "publish" | "discard" | "activate" | "check", fn: () => Promise<void>) => {
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
    const activationError = activation?.error ?? error;
    const failed = activationError ? describeError(activationError) : null;
    const working = activation?.busy || busy !== null;
    const mayActivate = canPublish && activation?.status === "ready" && !activation.current && !activation.pending
      && !activation.error && !blocked && !working;
    return (
      <Card tone="quiet" title={activation?.current ? "Policy active" : "Published"}>
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
        <div className="publish" aria-live="polite">
          {activation?.current ? (
            <p><Badge tone="ok">In effect</Badge> This document matches the policy active in this workspace.</p>
          ) : activation?.status === "loading" || activation?.status === "idle" ? (
            <p role="status" className="muted">Checking the active policy…</p>
          ) : (
            <p className="muted">Publishing preserves this version. Activating it updates the runtime policy for this workspace.</p>
          )}
          {activation?.pending ? (
            <p role="alert"><strong>Activation outcome is unconfirmed.</strong> Check the active policy before taking another action.
              The request will not be sent again.</p>
          ) : failed ? (
            <p role="alert"><strong>{failed.title}.</strong> {failed.body}</p>
          ) : null}
          {(!activation || activation.status === "unavailable") && (
            <p className="muted">Policy activation is not available from this server.</p>
          )}
          {!canPublish && <p className="muted">Only approvers can activate a published policy.</p>}
          {activation && activation.status !== "unavailable" && !activation.current && (
            <>
              {confirm && mayActivate ? (
                <div className="publish-confirm">
                  <p>Activate <span className="mono">{draft.path}</span> in this workspace? The reviewed content and active version
                    are checked again before it takes effect. This does not deploy application code.</p>
                  <div className="publish-row">
                    <Button variant="primary" disabled={!mayActivate} loading={busy === "activate" || activation.busy}
                      onClick={() => void run("activate", activation.activate)}>Activate policy</Button>
                    <Button variant="ghost" disabled={working} onClick={() => setConfirm(false)}>Cancel activation</Button>
                  </div>
                </div>
              ) : (
                <div className="publish-row">
                  {canPublish && !activation.pending && (
                    <Button variant="primary" disabled={!mayActivate} loading={activation.busy}
                      onClick={() => setConfirm(true)}>Activate policy…</Button>
                  )}
                  <Button variant="ghost" disabled={working} loading={busy === "check"}
                    onClick={() => void run("check", activation.reload)}>
                    {activation.pending ? "Check active policy" : "Reload active policy"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
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
              name on it. Activation is a separate step after publication.
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
