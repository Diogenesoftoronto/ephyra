import type { TeamInvitation, TeamInviteInput, TeamInviteResult, TeamRevokeInput, TeamState, WorkspaceAccess } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import type { TeamApi } from "../team-api.ts";

const CREATED = "2026-11-08T12:00:00.000Z";
const EXPIRES = "2026-11-15T12:00:00.000Z";
export const EMPTY_TEAM_FIXTURE: TeamState = {
  workspaceId: "storybook-repository-workspace",
  ownerDid: "did:plc:storybook-owner",
  version: 0,
  invitations: [],
};
export const TEAM_FIXTURE: TeamState = {
  ...EMPTY_TEAM_FIXTURE,
  version: 3,
  invitations: [
    {
      id: "storybook-viewer", label: "Product review", role: "viewer", createdAt: CREATED, expiresAt: EXPIRES,
      acceptedBy: "did:plc:storybook-viewer", acceptedAt: CREATED, revokedAt: null,
    },
    {
      id: "storybook-approver", label: "Release partner", role: "approver", createdAt: CREATED, expiresAt: EXPIRES,
      acceptedBy: "did:plc:storybook-approver", acceptedAt: CREATED, revokedAt: null,
    },
    {
      id: "storybook-pending", label: "Design review", role: "viewer", createdAt: CREATED, expiresAt: EXPIRES,
      acceptedBy: null, acceptedAt: null, revokedAt: null,
    },
  ],
};
export const INVITED_WORKSPACE_FIXTURE: WorkspaceAccess = {
  workspaceId: "storybook-invited-workspace",
  ownerDid: "did:plc:storybook-inviter",
  name: "Observatory",
  role: "viewer",
};

type Method = keyof TeamApi;
type WriteMethod = "invite" | "revoke" | "accept";
export interface FakeTeamOptions {
  initial?: TeamState;
  acceptedWorkspace?: WorkspaceAccess;
  fail?: Partial<Record<Method, Error>>;
  hang?: Method[];
  /** The fixture saves once, loses its first response, then returns the saved operation on explicit retry. */
  uncertainAfterSave?: WriteMethod[];
}

/** Fictional Storybook/demo state. No invitation, account, or network request is created. */
export class FakeTeamApi implements TeamApi {
  private value: TeamState;
  private nextId = 0;
  private joined: WorkspaceAccess | null = null;
  private readonly operations = new Map<string, { signature: string; result: unknown }>();

  constructor(private readonly options: FakeTeamOptions = {}) {
    this.value = structuredClone(options.initial ?? TEAM_FIXTURE);
  }
  private async before(method: Method) {
    if (this.options.hang?.includes(method)) await new Promise<never>(() => {});
    if (this.options.fail?.[method]) throw this.options.fail[method];
  }
  async team() {
    await this.before("team");
    return structuredClone(this.value);
  }
  private async write<T>(method: WriteMethod, input: unknown, key: string, change: () => T): Promise<T> {
    await this.before(method);
    const signature = JSON.stringify([method, input]);
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.signature !== signature) throw new ApiError(409, "This operation key belongs to a different change.");
      return structuredClone(prior.result as T);
    }
    const result = change();
    this.operations.set(key, { signature, result: structuredClone(result) });
    if (this.options.uncertainAfterSave?.includes(method)) throw new UnknownWriteOutcome(key);
    return structuredClone(result);
  }
  private check(input: TeamInviteInput | TeamRevokeInput) {
    if (input.expectedVersion !== this.value.version || input.workspaceId !== this.value.workspaceId) {
      throw new ApiError(409, "Team details changed. Reload them before making this change.");
    }
  }
  async invite(input: TeamInviteInput, key: string): Promise<TeamInviteResult> {
    const result = await this.write("invite", input, key, () => {
      this.check(input);
      const id = `storybook-invitation-${++this.nextId}`;
      const invitation: TeamInvitation = {
        id, label: input.label, role: input.role, createdAt: CREATED, expiresAt: EXPIRES,
        acceptedBy: null, acceptedAt: null, revokedAt: null,
      };
      this.value = { ...this.value, version: this.value.version + 1, invitations: [...this.value.invitations, invitation] };
      return { team: this.value, token: `storybook-token-${id}`, invitationId: id };
    });
    return { ...result, team: structuredClone(this.value) };
  }
  async revoke(input: TeamRevokeInput, key: string) {
    await this.write("revoke", input, key, () => {
      this.check(input);
      if (!this.value.invitations.some((row) => row.id === input.id)) throw new ApiError(404);
      this.value = {
        ...this.value, version: this.value.version + 1,
        invitations: this.value.invitations.map((row) => row.id === input.id ? { ...row, revokedAt: CREATED } : row),
      };
      return this.value;
    });
    return structuredClone(this.value);
  }
  async accept(token: string, key: string) {
    return this.write("accept", { token }, key, () => {
      if (!token.startsWith("storybook-token-")) throw new ApiError(410, "This fictional invitation is no longer available.");
      if (this.joined) throw new ApiError(409, "This fictional link was already used.");
      this.joined = structuredClone(this.options.acceptedWorkspace ?? INVITED_WORKSPACE_FIXTURE);
      return this.joined;
    });
  }
  async preview(token: string) {
    await this.before("preview");
    if (!token.startsWith("storybook-token-")) throw new ApiError(410, "This fictional invitation is no longer available.");
    return { workspace: structuredClone(this.options.acceptedWorkspace ?? INVITED_WORKSPACE_FIXTURE), expiresAt: EXPIRES };
  }
  async workspaces() {
    await this.before("workspaces");
    return structuredClone([
      { workspaceId: this.value.workspaceId, ownerDid: this.value.ownerDid, name: "Your workspace", role: "owner" as const },
      ...(this.joined ? [this.joined] : []),
    ]);
  }
}
