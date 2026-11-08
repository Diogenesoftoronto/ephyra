import { playFeedback } from "../lib/feedback.ts";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { TeamInvitation, TeamInviteInput, TeamRevokeInput, TeamRole, TeamState } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import { invitationUrl, type TeamApi } from "../team-api.ts";
import { Badge, Button, Card, Empty, Field, Icon, PageHeader, Skeleton } from "../kit.ts";
import { InvitationCode } from "../components/InvitationCode.tsx";
import { useNow } from "../lib/clock.tsx";
import "./TeamPage.css";

type Operation =
  | { kind: "invite"; input: TeamInviteInput; key: string }
  | { kind: "revoke"; input: TeamRevokeInput; key: string };
type Feedback = { kind: "success" | "error" | "uncertain" | "stale"; message: string };
type ShareLink = { url: string; label: string; role: TeamRole; invitationId?: string };

const roles = [
  { id: "viewer", name: "Viewer", detail: "Follow runs, read quests, and see costs.", icon: "runs" },
  { id: "approver", name: "Approver", detail: "Everything a viewer can do, plus approve changes and spend under your policy.", icon: "check" },
] as const;

function problem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has ended. Sign in again to manage your team.";
    if (error.status === 403) return "Only the workspace owner can manage invitations. Return to your own workspace to invite people there.";
    if (error.status === 409) return "Team details changed in another window. Check saved state, then review your change.";
    if (error.status === 404) return "This invitation could not be found. Check saved state to see the latest team.";
    if (error.detail) return `${error.detail} Check saved state before trying again.`;
  }
  return "Team details could not be reached. Check your connection, then try again.";
}

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Date unavailable" : parsed.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function inviteStatus(invitation: TeamInvitation, now: number): string {
  if (invitation.revokedAt) return invitation.acceptedBy ? "Access removed" : "Revoked";
  if (invitation.acceptedBy) return "Joined";
  return Date.parse(invitation.expiresAt) <= now ? "Expired" : "Waiting to join";
}

function RevokeConfirmation({ invitation, onConfirm, onCancel }: {
  invitation: TeamInvitation;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const joined = Boolean(invitation.acceptedBy);
  return (
    <dialog
      className="team-confirm" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
    >
      <h2 id={titleId}>{joined ? "Remove this access?" : "Revoke this invitation?"}</h2>
      <p className="team-confirm-label">{invitation.label}</p>
      <p id={descriptionId}>
        {joined
          ? "This removes this teammate’s workspace access. You can invite them again if you change your mind."
          : "This link will stop working. You can create a new invitation if you change your mind."}
      </p>
      <div className="team-actions">
        <Button autoFocus onClick={onCancel}>Keep {joined ? "access" : "invitation"}</Button>
        <Button variant="danger" onClick={onConfirm}>{joined ? "Remove access" : "Revoke invitation"}</Button>
      </div>
    </dialog>
  );
}

export function TeamPage({ api, onChanged }: { api: TeamApi; onChanged?: () => void }) {
  const now = useNow(1000);
  const [team, setTeam] = useState<TeamState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<TeamRole>("viewer");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"refresh" | "invite" | "revoke" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [checked, setChecked] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [confirm, setConfirm] = useState<TeamInvitation | null>(null);
  const pending = useRef<Operation | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const labelInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const shareHeading = useRef<HTMLHeadingElement>(null);
  const feedbackRegion = useRef<HTMLDivElement>(null);
  const confirmOpener = useRef<HTMLButtonElement | null>(null);
  const formId = useId();

  useEffect(() => {
    const session = ++generation.current;
    pending.current = null;
    active.current = false;
    setTeam(null);
    setLoading(true);
    setLoadError(null);
    setFeedback(null);
    setShare(null);
    setBusy(null);
    api.team().then(
      (next) => { if (session === generation.current) { setTeam(next); setLoading(false); } },
      (error) => { if (session === generation.current) { setLoadError(problem(error)); setLoading(false); } },
    );
    return () => { generation.current++; };
  }, [api]);

  const uncertain = feedback?.kind === "uncertain";
  const locked = Boolean(busy || uncertain || feedback?.kind === "stale");
  const shareInvitation = share?.invitationId ? team?.invitations.find((row) => row.id === share.invitationId) : undefined;
  const linkUnavailable = shareInvitation && inviteStatus(shareInvitation, now) !== "Waiting to join";
  const members = team?.invitations.filter((row) => row.acceptedBy && !row.revokedAt) ?? [];
  const invitations = team?.invitations.filter((row) => !row.acceptedBy && !row.revokedAt) ?? [];
  const history = team?.invitations.filter((row) => row.revokedAt) ?? [];

  async function refresh() {
    if (active.current) return;
    active.current = true;
    const session = generation.current;
    setBusy("refresh");
    try {
      const next = await api.team();
      if (session !== generation.current) return;
      setTeam(next);
      setLoadError(null);
      const operation = pending.current;
      if (operation) {
        const revoked = operation.kind === "revoke" && next.invitations.some(
          (row) => row.id === operation.input.id && row.revokedAt,
        );
        if (revoked) {
          pending.current = null;
          setFeedback({ kind: "success", message: "Saved state confirms this invitation’s access has been revoked." });
          onChanged?.();
        } else {
          setChecked(true);
          setFeedback({
            kind: "uncertain",
            message: operation.kind === "invite"
              ? "Latest team state loaded. Retry this same operation to recover its original link; it will not create a second invitation."
              : "Latest team state loaded. The revocation is not confirmed. You can retry this same operation.",
          });
        }
      } else {
        setFeedback({ kind: "success", message: "Latest team details loaded. You can review your next change." });
      }
    } catch (error) {
      if (session !== generation.current) return;
      if (!team) setLoadError(problem(error));
      else setFeedback({
        kind: pending.current ? "uncertain" : "error",
        message: "Saved state could not be reached. Nothing was retried. Check your connection and try again.",
      });
    } finally {
      if (session === generation.current) { active.current = false; setBusy(null); setLoading(false); }
    }
  }

  async function perform(operation: Operation) {
    if (active.current) return;
    active.current = true;
    const session = generation.current;
    pending.current = operation;
    setBusy(operation.kind);
    setFeedback(null);
    setChecked(false);
    setConfirm(null);
    try {
      let next: TeamState;
      if (operation.kind === "invite") {
        const result = await api.invite(operation.input, operation.key);
        if (session !== generation.current) return;
        next = result.team;
        setShare({
          url: invitationUrl(result.token, window.location.origin),
          label: operation.input.label, role: operation.input.role, invitationId: result.invitationId,
        });
        playFeedback("invitation");
        setCopyState("idle");
        setLabel("");
      } else {
        next = await api.revoke(operation.input, operation.key);
        if (session !== generation.current) return;
      }
      pending.current = null;
      setTeam(next);
      setFeedback({ kind: "success", message: operation.kind === "invite" ? "Invitation details loaded below." : "Access revoked." });
      onChanged?.();
      try {
        const current = await api.team();
        if (session === generation.current) setTeam(current);
      } catch {
        if (session === generation.current) setFeedback({
          kind: "success", message: "Your change was saved. The latest team list could not be refreshed; check saved state when you reconnect.",
        });
      }
      if (operation.kind === "invite") requestAnimationFrame(() => shareHeading.current?.focus());
    } catch (error) {
      if (session !== generation.current) return;
      if (error instanceof UnknownWriteOutcome) {
        setFeedback({
          kind: "uncertain",
          message: "The connection ended before we could confirm this change. It may have completed. Check saved state before retrying.",
        });
      } else {
        pending.current = null;
        setFeedback({ kind: error instanceof ApiError && error.status === 409 ? "stale" : "error", message: problem(error) });
      }
    } finally {
      if (session === generation.current) {
        active.current = false;
        setBusy(null);
        if (operation.kind === "revoke") requestAnimationFrame(() => feedbackRegion.current?.focus());
      }
    }
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team || locked || active.current) return;
    if (!label.trim()) {
      setLabelError("Add a label so you can recognize this invitation later.");
      labelInput.current?.focus();
      return;
    }
    setLabelError(null);
    void perform({
      kind: "invite", key: `team-invite-${crypto.randomUUID()}`,
      input: { expectedVersion: team.version, workspaceId: team.workspaceId, label: label.trim(), role },
    });
  }

  async function copy() {
    if (!share || linkUnavailable) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(share.url);
      setCopyState("copied");
      playFeedback("copy");
    } catch {
      setCopyState("manual");
      linkInput.current?.focus();
      linkInput.current?.select();
    }
  }

  function rows(items: TeamInvitation[]) {
    return <ul className="team-list">{items.map((item) => (
      <li key={item.id} className="team-person">
        <span className="team-person-mark" aria-hidden="true">{item.label.trim().slice(0, 1).toLocaleUpperCase()}</span>
        <div className="team-person-detail">
          <div className="team-person-name"><strong>{item.label}</strong><Badge>{item.role === "viewer" ? "Viewer" : "Approver"}</Badge></div>
          {item.acceptedBy && <code className="team-identity">{item.acceptedBy}</code>}
          <p className="team-note">
            {inviteStatus(item, now)} · {item.revokedAt ? `Revoked ${date(item.revokedAt)}`
              : item.acceptedAt ? date(item.acceptedAt) : `Link expires ${date(item.expiresAt)}`}
          </p>
        </div>
        {!item.revokedAt && (
          <Button
            size="sm" variant="ghost" disabled={locked}
            aria-label={`${item.acceptedBy ? "Remove access for" : "Revoke invitation for"} ${item.label}`}
            onClick={(event) => { confirmOpener.current = event.currentTarget; setConfirm(item); }}
          >{item.acceptedBy ? "Remove access" : "Revoke"}</Button>
        )}
      </li>
    ))}</ul>;
  }

  return (
    <div className="page team-page">
      <PageHeader title="Team" lede="Invite your team to follow the work and help with approvals."
        actions={<Button size="sm" disabled={loading || Boolean(busy)} onClick={() => void refresh()}>Refresh</Button>} />
      <div ref={feedbackRegion} tabIndex={-1} className="team-feedback" role="status" aria-live="polite" aria-atomic="true">
        {feedback && <p data-tone={feedback.kind}>{feedback.message}</p>}
        {busy && <p>{busy === "refresh" ? "Checking saved team details…" : busy === "invite" ? "Creating invitation…" : "Revoking access…"}</p>}
      </div>
      {feedback && <div className="team-actions">
        <Button size="sm" onClick={() => void refresh()} loading={busy === "refresh"} disabled={Boolean(busy)}>
          Check saved state
        </Button>
        {uncertain && checked && <Button
          size="sm" onClick={() => { if (pending.current) void perform(pending.current); }} disabled={Boolean(busy)}
        >Retry same operation</Button>}
      </div>}
      {loading && <div className="team-loading"><p role="status">Loading your team…</p><Skeleton lines={5} /></div>}
      {loadError && <Card tone="alert" title="Your team could not be loaded">
        <p role="alert">{loadError}</p>
        <Button onClick={() => void refresh()} loading={busy === "refresh"}>Try again</Button>
      </Card>}
      {team && <>
        <div className="team-invite-layout">
          <Card className="team-invite-card" title="Invite someone in" meta="A single-use link, shared by you">
            <form className="team-invite-form" onSubmit={invite} noValidate>
              <Field
                label="Invitation label" error={labelError}
                hint="A name or note to recognize this invitation. It does not verify the recipient’s identity."
              >
                <input
                  ref={labelInput} name="invitationLabel" autoComplete="off" type="text" maxLength={100}
                  placeholder="For example, Sam · release review" value={label} disabled={locked}
                  onChange={(event) => { setLabel(event.target.value); setLabelError(null); }}
                />
              </Field>
              <fieldset className="team-role-choices" disabled={locked} aria-describedby={`${formId}-permissions`}>
                <legend>Choose their access</legend>
                {roles.map((option) => <label key={option.id} className="team-role" data-selected={role === option.id}>
                  <input type="radio" name={`${formId}-role`} value={option.id} checked={role === option.id} onChange={() => setRole(option.id)} />
                  <span><strong><Icon name={option.icon} />{option.name}</strong><span>{option.detail}</span></span>
                </label>)}
              </fieldset>
              <p className="team-note" id={`${formId}-permissions`}>Only the owner can manage account settings and team access.</p>
              <div className="team-actions"><Button type="submit" variant="primary" loading={busy === "invite"} disabled={locked}>
                Create invitation link
              </Button></div>
            </form>
          </Card>
          <aside className="team-guide">
            <span className="ui-label">A shared view</span>
            <h2>Follow the work.<br /> Choose who decides.</h2>
            <img className="team-guide-art" src="/app/materials/experiments/flux-glass-gathering.webp" alt=""
              width={1024} height={1024} loading="lazy" decoding="async" />
            <p>Your team can follow the same runs, evidence, and costs. Approvers can help at the checkpoints you set.</p>
            <ol>
              <li>Choose a role for this invitation.</li>
              <li>Share the link or let them scan your QR code.</li>
              <li>Your teammate signs in and joins.</li>
            </ol>
            <p className="team-note">Anyone with the link can join once. Unused links expire after seven days. No email is sent.</p>
          </aside>
        </div>
        {share && <Card className="team-share" tone="tray">
          <h2 ref={shareHeading} tabIndex={-1}>{linkUnavailable ? "This invitation is no longer open" : "A place is ready"}</h2>
          <p><strong>{share.label}</strong> · {share.role === "viewer" ? "Viewer" : "Approver"}</p>
          {linkUnavailable ? <p>{inviteStatus(shareInvitation!, now)}. Create a new invitation to share another link.</p> : <>
            <p>Share the link or QR code privately. Anyone who has either can join once.</p>
            <div className="team-share-layout">
              <InvitationCode url={share.url} role={share.role} />
              <div className="team-share-controls">
              <Field label="Invitation link" hint={shareInvitation ? `Expires ${date(shareInvitation.expiresAt)}.` : "Expires seven days after creation."}>
                <input ref={linkInput} type="text" name="invitationLink" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} />
              </Field>
              <Button variant="primary" onClick={() => void copy()}><Icon name={copyState === "copied" ? "check" : "copy"} />
                {copyState === "copied" ? "Copied" : "Copy link"}
              </Button>
              </div>
            </div>
          </>}
          <p className="team-copy-feedback" role="status" aria-live="polite">
            {copyState === "copied" ? "Link copied. It is ready to share privately."
              : copyState === "manual" ? "Clipboard access is unavailable. Select and copy the link above to share it." : ""}
          </p>
          {!linkUnavailable && <p className="team-note">Keep a copy before leaving this page. For privacy, this page does not store invitation links.</p>}
        </Card>}
        <Card title="People with access" meta={`${members.length + 1} ${members.length ? "people" : "person"}`}>
          <div className="team-person team-owner">
            <span className="team-person-mark" aria-hidden="true"><Icon name="workspace" /></span>
            <div className="team-person-detail"><div className="team-person-name"><strong>Workspace owner</strong><Badge>Owner</Badge></div>
              <code className="team-identity">{team.ownerDid}</code>
              <p className="team-note">Manages the workspace, account, and team.</p>
            </div>
          </div>
          {members.length ? rows(members) : <Empty title="Room for your team" body="Invite someone to follow the models’ work or help with approvals." />}
        </Card>
        <Card title="Invitations" meta={`${invitations.length} ${invitations.length === 1 ? "link" : "links"}`}>
          {invitations.length ? rows(invitations) : <p className="team-note">No open invitations. Create a link when you are ready to bring someone in.</p>}
        </Card>
        {history.length > 0 && <details className="team-history"><summary>Revoked invitations ({history.length})</summary>{rows(history)}</details>}
        {confirm && <RevokeConfirmation invitation={confirm} onCancel={() => {
          setConfirm(null);
          requestAnimationFrame(() => confirmOpener.current?.focus());
        }} onConfirm={() => void perform({
          kind: "revoke", key: `team-revoke-${crypto.randomUUID()}`,
          input: { expectedVersion: team.version, workspaceId: team.workspaceId, id: confirm.id },
        })} />}
      </>}
    </div>
  );
}
