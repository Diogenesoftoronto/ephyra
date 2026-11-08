import { TeamInvitationPreview, TeamInviteInput, TeamInviteResult, TeamRevokeInput, TeamState, WorkspaceAccess } from "@ephyra/core";
import { z } from "zod";
import { ApiError, UnknownWriteOutcome } from "./api.ts";

export interface TeamApi {
  team(): Promise<TeamState>;
  invite(input: TeamInviteInput, operationKey: string): Promise<TeamInviteResult>;
  revoke(input: TeamRevokeInput, operationKey: string): Promise<TeamState>;
  accept(token: string, operationKey: string): Promise<WorkspaceAccess>;
  preview(token: string): Promise<TeamInvitationPreview>;
  workspaces(): Promise<WorkspaceAccess[]>;
}

/** Account-bound requests. Writes are never retried automatically. */
export class TeamClient implements TeamApi {
  constructor(
    private readonly origin: string,
    private readonly token = "",
    private readonly fetcher: typeof fetch = fetch,
    private readonly did?: string,
  ) {}

  private async request<T>(
    path: string, schema: z.ZodType<T>, input?: unknown, operationKey?: string, readOnlyPost = false, workspaceId?: string,
  ): Promise<T> {
    const writing = input !== undefined && !readOnlyPost;
    if (writing && !operationKey) throw new Error("A team change needs an operation key.");
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(new URL(`/v1/account${path}`, this.origin), {
        method: input !== undefined ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(this.did ? { "X-Ephyra-Account": this.did } : {}),
          ...(workspaceId ? { "X-Ephyra-Workspace": workspaceId } : {}),
          ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(writing ? { "Idempotency-Key": operationKey! } : {}),
        },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
      });
    } catch {
      if (operationKey) throw new UnknownWriteOutcome(operationKey);
      throw new Error("Team details could not be reached. Check your connection and try again.");
    }
    if (!response.ok) {
      if (operationKey && response.status >= 500) throw new UnknownWriteOutcome(operationKey);
      const body = await response.json().catch(() => null);
      throw new ApiError(response.status, typeof body?.error === "string" ? body.error.slice(0, 500) : undefined);
    }
    try {
      return schema.parse(await response.json());
    } catch {
      if (operationKey) throw new UnknownWriteOutcome(operationKey);
      throw new Error("Team details could not be read. Reload to try again.");
    }
  }

  team() { return this.request("/team", TeamState); }
  invite(input: TeamInviteInput, operationKey: string) {
    return this.request("/team/invitations", TeamInviteResult, TeamInviteInput.parse(input), operationKey, false, input.workspaceId);
  }
  revoke(input: TeamRevokeInput, operationKey: string) {
    return this.request("/team/revoke", TeamState, TeamRevokeInput.parse(input), operationKey, false, input.workspaceId);
  }
  accept(token: string, operationKey: string) {
    return this.request("/team/accept", WorkspaceAccess, { token }, operationKey);
  }
  preview(token: string) {
    return this.request("/team/preview", TeamInvitationPreview, { token }, undefined, true);
  }
  workspaces() { return this.request("/workspaces", z.array(WorkspaceAccess)); }
}

/** Put the secret in the recipient's fragment, so the invitation URL does not send it to the HTTP server. */
export function invitationUrl(token: string, origin: string): string {
  const url = new URL("/app/", origin);
  url.hash = `/join/${encodeURIComponent(token)}`;
  return url.href;
}
