import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  TeamInvitation, type TeamState, type TeamInviteInput, type TeamInviteResult,
  type TeamRevokeInput, type WorkspaceAccess, type TeamInvitationPreview,
} from "@ephyra/core";
import { canonicalJson } from "../audit.ts";
import { AccountError, initialAccount } from "./accounts.ts";
import type { AccountRecord, AccountStore } from "./account-store.ts";
import type { StoredTeamInvitation } from "./team-record.ts";

const EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const tokenEnvelope = z.object({
  owner: z.string().min(1).max(512),
  id: z.string().regex(/^invite_[a-f0-9]{32}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type SharedWorkspace = { record: AccountRecord; access: WorkspaceAccess; invitationId: string };

export class Teams {
  constructor(readonly store: AccountStore, private readonly secret: string, private readonly now = () => Date.now()) {}

  private keyed(value: unknown) {
    return createHmac("sha256", this.secret).update(canonicalJson(value)).digest("hex");
  }
  private operationKey(key: string) {
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(key)) throw new AccountError(400, "A valid operation key is required.");
  }
  private invitations(record: AccountRecord): StoredTeamInvitation[] {
    return record.team?.workspaceId === record.settings.workspaceId ? record.team.invitations : [];
  }
  private state(record: AccountRecord): TeamState {
    return {
      workspaceId: record.settings.workspaceId, ownerDid: record.settings.did, version: record.settings.version,
      invitations: this.invitations(record).map((invitation) => TeamInvitation.parse(invitation)),
    };
  }
  private access(record: AccountRecord, role: WorkspaceAccess["role"]): WorkspaceAccess {
    const repository = record.settings.repository;
    const name = repository ? new URL(repository.url).pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") : undefined;
    return { workspaceId: record.settings.workspaceId, ownerDid: record.settings.did,
      name: name || (role === "owner" ? "Personal workspace" : `Workspace by ${record.settings.did}`), role };
  }
  private bound(record: AccountRecord, workspaceId: string) {
    if (record.settings.workspaceId !== workspaceId)
      throw new AccountError(409, "Your workspace changed. Refresh before managing invitations.");
  }
  private async current(did: string) {
    return this.store.ensure(initialAccount(did));
  }
  async team(did: string, workspaceId?: string): Promise<TeamState> {
    const record = await this.current(did);
    if (workspaceId) this.bound(record, workspaceId);
    return this.state(record);
  }
  async workspaces(did: string): Promise<WorkspaceAccess[]> {
    const personal = await this.current(did);
    const result = [this.access(personal, "owner")];
    for (const record of await this.store.list()) {
      if (record.settings.did === did) continue;
      const member = this.invitations(record).find((item) => item.acceptedBy === did && !item.revokedAt);
      if (member) result.push(this.access(record, member.role));
    }
    return result;
  }
  /** No role, owner identity or previously cached membership supplied by a caller is trusted. */
  async shared(did: string, workspaceId: string): Promise<SharedWorkspace | null> {
    for (const record of await this.store.list()) {
      if (record.settings.workspaceId !== workspaceId || record.settings.did === did) continue;
      const member = this.invitations(record).find((item) => item.acceptedBy === did && !item.revokedAt);
      if (member) return { record, access: this.access(record, member.role), invitationId: member.id };
    }
    return null;
  }
  async canApprove(owner: string, workspaceId: string, did: string): Promise<boolean> {
    const record = await this.store.get(owner);
    if (!record || record.settings.workspaceId !== workspaceId) return false;
    if (did === owner) return true;
    return this.invitations(record).some((item) => item.acceptedBy === did && !item.revokedAt && item.role === "approver");
  }
  async stillShared(owner: string, workspaceId: string, did: string, invitationId: string): Promise<boolean> {
    const record = await this.store.get(owner);
    return Boolean(record && record.settings.workspaceId === workspaceId && this.invitations(record).some(
      (item) => item.id === invitationId && item.acceptedBy === did && !item.revokedAt,
    ));
  }

  private async change(
    owner: string, key: string, digest: string, current: AccountRecord, expectedVersion: number,
    update: (record: AccountRecord) => void,
  ): Promise<AccountRecord> {
    const begun = await this.store.begin(owner, key, digest, expectedVersion);
    if (begun.status === "completed") {
      // Never restore an old receipt: revocation and repository changes take precedence over replay.
      const saved = await this.store.get(owner);
      if (!saved) throw new AccountError(409, "The workspace is no longer available.");
      return saved;
    }
    if (begun.status === "failed") throw new AccountError(409, begun.error);
    if (begun.status === "pending") throw new AccountError(409, "This operation has an uncertain outcome. Check the saved team before retrying.");
    if (begun.status === "conflict" || current.settings.version !== expectedVersion)
      throw new AccountError(409, "The team or settings changed, or this operation key was already used. Refresh before continuing.");
    const next = structuredClone(current);
    try {
      update(next);
      next.settings.version++;
    } catch (error) {
      const safe = error instanceof AccountError ? error : new AccountError(422, "The team change could not be completed.");
      await this.store.fail(owner, key, digest, safe.message);
      throw safe;
    }
    // An ambiguous database result is never retried, failed, or transformed into a new invitation.
    if (!await this.store.complete(owner, key, digest, next))
      throw new AccountError(409, "The team changed while saving. Check the saved team before continuing.");
    return next;
  }

  async invite(did: string, input: TeamInviteInput, key: string): Promise<TeamInviteResult> {
    this.operationKey(key);
    const current = await this.current(did);
    this.bound(current, input.workspaceId);
    const id = `invite_${this.keyed(["invitation-id", did, input.workspaceId, key]).slice(0, 32)}`;
    const secret = Buffer.from(this.keyed(["invitation-secret", did, input.workspaceId, key]), "hex").toString("base64url");
    const token = Buffer.from(JSON.stringify({ owner: did, id, secret })).toString("base64url");
    const saved = await this.change(did, key, this.keyed(["invite", did, input]), current, input.expectedVersion, (record) => {
      const invitations = this.invitations(record);
      if (invitations.length >= 1000) throw new AccountError(422, "This workspace has reached its invitation limit.");
      const createdAt = this.now();
      record.team = { workspaceId: input.workspaceId, invitations: [...invitations, {
        id, label: input.label, role: input.role, tokenHash: hash(secret),
        createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + EXPIRES_MS).toISOString(),
        acceptedBy: null, acceptedAt: null, revokedAt: null,
      }] };
    });
    this.bound(saved, input.workspaceId);
    if (!this.invitations(saved).some((item) => item.id === id))
      throw new AccountError(409, "This invitation no longer belongs to the current workspace.");
    return { team: this.state(saved), token, invitationId: id };
  }
  async revoke(did: string, input: TeamRevokeInput, key: string): Promise<TeamState> {
    this.operationKey(key);
    const current = await this.current(did);
    this.bound(current, input.workspaceId);
    const saved = await this.change(did, key, this.keyed(["revoke", did, input]), current, input.expectedVersion, (record) => {
      const invitation = this.invitations(record).find((item) => item.id === input.id);
      if (!invitation) throw new AccountError(422, "This invitation was not found in your workspace.");
      invitation.revokedAt ??= new Date(this.now()).toISOString();
    });
    this.bound(saved, input.workspaceId);
    return this.state(saved);
  }
  private async invitation(did: string, token: string) {
    let envelope: z.infer<typeof tokenEnvelope>;
    try {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid");
      envelope = tokenEnvelope.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    } catch {
      throw new AccountError(400, "This invitation link is invalid.");
    }
    const current = await this.store.get(envelope.owner);
    const invitation = current && this.invitations(current).find((item) => item.id === envelope.id);
    if (!current || !invitation || !timingSafeEqual(Buffer.from(invitation.tokenHash, "hex"), Buffer.from(hash(envelope.secret), "hex")))
      throw new AccountError(403, "This invitation is unavailable or belongs to a previous workspace.");
    if (did === envelope.owner) throw new AccountError(409, "You already own this workspace. Share the link with a teammate.");
    if (invitation.revokedAt) throw new AccountError(403, "This invitation has been revoked.");
    if (!invitation.acceptedBy && Date.parse(invitation.expiresAt) <= this.now())
      throw new AccountError(422, "This invitation has expired. Ask the owner for a new link.");
    if (invitation.acceptedBy && invitation.acceptedBy !== did)
      throw new AccountError(409, "This invitation has already been used.");
    return { current, envelope, invitation };
  }
  async preview(did: string, token: string): Promise<TeamInvitationPreview> {
    const { current, invitation } = await this.invitation(did, token);
    if (invitation.acceptedBy) throw new AccountError(409, "This invitation has already been used.");
    return { workspace: this.access(current, invitation.role), expiresAt: invitation.expiresAt };
  }
  async accept(did: string, token: string, key: string): Promise<WorkspaceAccess> {
    this.operationKey(key);
    const { current, envelope } = await this.invitation(did, token);
    const operation = `accept:${hash(did)}:${key}`;
    const saved = await this.change(envelope.owner, operation, this.keyed(["accept", did, hash(token)]), current, current.settings.version, (record) => {
      const target = this.invitations(record).find((item) => item.id === envelope.id)!;
      if (target.acceptedBy) throw new AccountError(409, "This invitation has already been used.");
      if (this.invitations(record).some((item) => item.acceptedBy === did && !item.revokedAt))
        throw new AccountError(409, "You already have access. Ask the owner to revoke your current role before inviting you with another role.");
      target.acceptedBy = did;
      target.acceptedAt = new Date(this.now()).toISOString();
    });
    const accepted = this.invitations(saved).find((item) => item.id === envelope.id && item.acceptedBy === did && !item.revokedAt);
    if (!accepted) throw new AccountError(403, "This workspace access is no longer available.");
    return this.access(saved, accepted.role);
  }
}
