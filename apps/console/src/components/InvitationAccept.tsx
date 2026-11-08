import { useEffect, useRef, useState } from "react";
import type { TeamInvitationPreview, WorkspaceAccess } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import type { TeamApi } from "../team-api.ts";
import { Badge, Button, Card, Icon, Skeleton } from "../kit.ts";
import "./InvitationAccept.css";

type State =
  | { kind: "ready" }
  | { kind: "loading" | "joining" | "checking" }
  | { kind: "uncertain" | "error"; message: string }
  | { kind: "joined"; workspace: WorkspaceAccess };

function invitationProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has ended. Return to sign-in, then open this invitation again.";
    if ([400, 404, 410, 422].includes(error.status)) {
      return "This invitation is no longer available. It may have expired, been used, or been revoked. Ask the inviter for a new link.";
    }
    if (error.status === 409) return "You may already have access, or this invitation has changed. Check your saved access before trying again.";
    if (error.status === 403) return "This invitation is unavailable for this account. It may have been revoked. Ask the workspace owner for a new link.";
  }
  return "The invitation could not be checked. Check your connection and try again, or ask the inviter for a new link.";
}

export function InvitationAccept({ api, token, onAccepted, onCancel }: {
  api: TeamApi;
  token: string;
  onAccepted: (workspace: WorkspaceAccess) => void;
  onCancel?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [preview, setPreview] = useState<TeamInvitationPreview | null>(null);
  const [previewToken, setPreviewToken] = useState("");
  const [previewTick, setPreviewTick] = useState(0);
  const [checked, setChecked] = useState(false);
  const [savedAccess, setSavedAccess] = useState<WorkspaceAccess[] | null>(null);
  const [accessMessage, setAccessMessage] = useState("");
  const operation = useRef<string | null>(null);
  const active = useRef(false);
  const uncertain = useRef(false);
  const generation = useRef(0);
  const busy = state.kind === "loading" || state.kind === "joining" || state.kind === "checking";

  useEffect(() => {
    const session = ++generation.current;
    operation.current = null;
    active.current = false;
    uncertain.current = false;
    setState({ kind: "loading" });
    setPreview(null);
    setChecked(false);
    setSavedAccess(null);
    setAccessMessage("");
    api.preview(token).then(
      (next) => {
        if (session !== generation.current) return;
        setPreview(next);
        setPreviewToken(token);
        setState({ kind: "ready" });
      },
      (error) => {
        if (session === generation.current) setState({ kind: "error", message: invitationProblem(error) });
      },
    );
    return () => { generation.current++; };
  }, [api, token, previewTick]);

  async function join() {
    if (!preview || previewToken !== token || active.current || state.kind === "joined" || (uncertain.current && !checked)) return;
    if (!token || token.length > 2048) {
      setState({ kind: "error", message: "This invitation link is incomplete. Ask the inviter to send the full link again." });
      return;
    }
    active.current = true;
    const session = generation.current;
    operation.current ??= `team-accept-${crypto.randomUUID()}`;
    setState({ kind: "joining" });
    let joined: WorkspaceAccess | null = null;
    try {
      const workspace = await api.accept(token, operation.current);
      if (session !== generation.current) return;
      uncertain.current = false;
      operation.current = null;
      setState({ kind: "joined", workspace });
      joined = workspace;
    } catch (error) {
      if (session !== generation.current) return;
      if (error instanceof UnknownWriteOutcome) {
        uncertain.current = true;
        setChecked(false);
        setState({
          kind: "uncertain",
          message: "The connection ended before we could confirm you joined. Check saved access before retrying this invitation.",
        });
      } else {
        uncertain.current = false;
        operation.current = null;
        if (error instanceof ApiError && [400, 401, 403, 404, 409, 410, 422].includes(error.status)) setPreview(null);
        setState({ kind: "error", message: invitationProblem(error) });
        if (error instanceof ApiError && [400, 403, 404, 410].includes(error.status)) setPreview(null);
      }
    } finally {
      if (session === generation.current) active.current = false;
    }
    if (joined && session === generation.current) onAccepted(joined);
  }

  async function checkAccess() {
    if (active.current) return;
    active.current = true;
    const session = generation.current;
    const previous = state;
    setState({ kind: "checking" });
    setAccessMessage("");
    try {
      const workspaces = await api.workspaces();
      if (session !== generation.current) return;
      setSavedAccess(workspaces);
      setChecked(true);
      setState(uncertain.current ? {
        kind: "uncertain",
        message: "Your saved access is listed below. Retry the same operation to confirm this invitation; it will not join twice.",
      } : previous);
      setAccessMessage("Latest workspace access loaded.");
    } catch {
      if (session !== generation.current) return;
      setState(previous);
      setAccessMessage("Saved access could not be reached. Nothing was retried. Check your connection and try again.");
    } finally {
      if (session === generation.current) active.current = false;
    }
  }

  const message = state.kind === "error" || state.kind === "uncertain" ? state.message
    : state.kind === "loading" ? "Checking your invitation…"
      : state.kind === "joining" ? "Checking the invitation and joining…"
      : state.kind === "checking" ? "Checking your saved workspace access…"
        : state.kind === "joined" ? `You joined ${state.workspace.name} as ${state.workspace.role}.` : "";

  return (
    <div className="invitation-accept">
      <Card className="invitation-card" tone="tray">
        <span className="invitation-mark" aria-hidden="true"><Icon name="personas" /></span>
        <span className="ui-label">You are invited</span>
        <h1>{state.kind === "joined" ? "You’re part of the team" : "Join your team’s workspace"}</h1>
        {state.kind === "joined" ? <>
          <p>You now have access to <strong>{state.workspace.name}</strong>.</p>
          <div><Badge tone="ok">{state.workspace.role === "approver" ? "Approver" : state.workspace.role === "viewer" ? "Viewer" : "Owner"}</Badge></div>
          <p>{state.workspace.role === "viewer"
            ? "Follow runs, read quests, and see what the models have spent."
            : "Follow the work and help approve changes and spend under the workspace’s policy."}</p>
          <Button variant="primary" onClick={() => onAccepted(state.workspace)}>Open shared workspace</Button>
        </> : <>
          <p>Join a shared workspace to see what the models are working on and follow the evidence together.</p>
          {state.kind === "loading" && <Skeleton lines={3} />}
          {preview && <div className="invitation-access-note">
            <span className="ui-label">Your shared workspace</span>
            <h2>{preview.workspace.name}</h2>
            <div><Badge tone="info">{preview.workspace.role === "approver" ? "Approver" : "Viewer"}</Badge></div>
            <p>{preview.workspace.role === "approver"
              ? "Follow runs, read quests, and see costs. You can also approve changes and spend under this workspace’s policy."
              : "Follow runs, read quests, and see costs. The owner and approvers handle decisions."}</p>
            <p className="invitation-note">Account settings and team access stay with the owner.</p>
            <p className="invitation-note">Workspace owner <code>{preview.workspace.ownerDid}</code></p>
          </div>}
          {preview && <p className="invitation-note">
            This invitation expires {new Date(preview.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
            {" "}Join when you are ready. Your own workspace stays available.
          </p>}
        </>}
        <div className="invitation-feedback" role="status" aria-live="polite" aria-atomic="true">
          {message && <p data-tone={state.kind}>{message}</p>}
          {accessMessage && <p>{accessMessage}</p>}
        </div>
        {state.kind !== "joined" && <div className="invitation-actions">
          {preview && state.kind !== "uncertain" && !uncertain.current && <Button
            variant="primary" onClick={() => void join()} loading={state.kind === "joining"} disabled={busy}
          >Join workspace</Button>}
          {!preview && state.kind === "error" && <Button variant="primary" onClick={() => setPreviewTick((tick) => tick + 1)}>
            Check invitation again
          </Button>}
          {(state.kind === "uncertain" || state.kind === "error" || state.kind === "checking") && <Button
            onClick={() => void checkAccess()} loading={state.kind === "checking"} disabled={busy}
          >Check saved access</Button>}
          {uncertain.current && checked && <Button variant="primary" disabled={busy} onClick={() => void join()}>
            Retry same operation
          </Button>}
        </div>}
        {savedAccess && <section className="invitation-saved-access" aria-label="Your saved workspace access">
          <h2>Your accessible workspaces</h2>
          {savedAccess.length ? <ul>{savedAccess.map((workspace) => <li key={workspace.workspaceId}>
            <div><strong>{workspace.name}</strong>
              <span>{workspace.role === "owner" ? "Owner" : workspace.role === "approver" ? "Approver" : "Viewer"}</span>
            </div>
            <Button size="sm" disabled={busy} onClick={() => onAccepted(workspace)} aria-label={`Open ${workspace.name}`}>Open</Button>
          </li>)}</ul> : <p>No workspace access is saved for this account yet.</p>}
        </section>}
        <div className="invitation-return">
          {onCancel ? <Button variant="ghost" onClick={onCancel} disabled={busy}>Return to your workspace</Button>
            : <a href="/app/">Return to your workspace</a>}
        </div>
      </Card>
    </div>
  );
}
