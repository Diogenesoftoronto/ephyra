import { TeamInvitation } from "@ephyra/core";
import { z } from "zod";

/** Server-only authority. The redeemable secret never enters either the account or an operation receipt. */
export const StoredTeamInvitation = TeamInvitation.extend({
  id: z.string().regex(/^invite_[a-f0-9]{32}$/),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((value) => (value.acceptedBy === null) === (value.acceptedAt === null), {
  message: "accepted identity and timestamp must agree",
});
export type StoredTeamInvitation = z.infer<typeof StoredTeamInvitation>;
export const TeamRecord = z.object({
  workspaceId: z.string().regex(/^ws_[a-f0-9]{40}$/),
  invitations: z.array(StoredTeamInvitation).max(1000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const invitation of value.invitations) {
    if (ids.has(invitation.id)) ctx.addIssue({ code: "custom", message: "duplicate invitation" });
    ids.add(invitation.id);
    if (invitation.acceptedBy && !invitation.revokedAt) {
      if (members.has(invitation.acceptedBy)) ctx.addIssue({ code: "custom", message: "duplicate active member" });
      members.add(invitation.acceptedBy);
    }
  }
});
export type TeamRecord = z.infer<typeof TeamRecord>;
