import { z } from "zod";
import { IsoTime, Sha } from "./schemas.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** A local reviewed control-plane policy activation, distinct from application deployment. */
export const PolicyActivationReceipt = z.object({
  schema: z.literal(1), draftId: z.string(), path: z.string(), sourceCommit: Sha, sourceDigest: digest,
  principal: z.string(), at: IsoTime, previousActive: Sha.nullable(), requestDigest: digest,
  documents: z.array(z.object({ path: z.string(), digest })).max(200), commit: Sha,
});
export type PolicyActivationReceipt = z.infer<typeof PolicyActivationReceipt>;
