import { z } from "zod";

export const TeamRole = z.enum(["viewer", "approver"]);
export type TeamRole = z.infer<typeof TeamRole>;
export const TeamInvitation = z.object({
  id: z.string(), label: z.string(), role: TeamRole, createdAt: z.string(), expiresAt: z.string(),
  acceptedBy: z.string().nullable(), acceptedAt: z.string().nullable(), revokedAt: z.string().nullable(),
});
export type TeamInvitation = z.infer<typeof TeamInvitation>;
export const TeamState = z.object({
  workspaceId: z.string(), ownerDid: z.string(), version: z.number().int().nonnegative(),
  invitations: z.array(TeamInvitation),
});
export type TeamState = z.infer<typeof TeamState>;
export const WorkspaceAccess = z.object({
  workspaceId: z.string(), ownerDid: z.string(), name: z.string(), role: z.enum(["owner", "viewer", "approver"]),
});
export type WorkspaceAccess = z.infer<typeof WorkspaceAccess>;
export const TeamInvitationPreview = z.object({ workspace: WorkspaceAccess, expiresAt: z.string() });
export type TeamInvitationPreview = z.infer<typeof TeamInvitationPreview>;
export const TeamInviteInput = z.object({
  expectedVersion: z.number().int().nonnegative(), workspaceId: z.string(),
  label: z.string().trim().min(1).max(100), role: TeamRole,
}).strict();
export type TeamInviteInput = z.infer<typeof TeamInviteInput>;
export const TeamRevokeInput = z.object({
  expectedVersion: z.number().int().nonnegative(), workspaceId: z.string(), id: z.string().min(1).max(100),
}).strict();
export type TeamRevokeInput = z.infer<typeof TeamRevokeInput>;
export const TeamAcceptInput = z.object({ token: z.string().min(16).max(2048) }).strict();
export const TeamInviteResult = z.object({ team: TeamState, token: z.string(), invitationId: z.string().optional() });
export type TeamInviteResult = z.infer<typeof TeamInviteResult>;
