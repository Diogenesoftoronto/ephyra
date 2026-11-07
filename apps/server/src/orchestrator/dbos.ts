import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Decision } from "@ephyra/core";

/** Register before DBOS.launch so recovery can find this workflow. */
export function registerApprovalWorkflow(releaseLease: (trailId: string) => Promise<void>) {
  const release = DBOS.registerStep(releaseLease, { name: "releaseApprovalLease", retriesAllowed: false });
  return DBOS.registerWorkflow(async (trailId: string): Promise<Decision> => {
    await release(trailId);
    // No runner lease is held while the durable message wait is suspended.
    for (;;) {
      const decision = await DBOS.recv<Decision>("approval");
      if (decision) return decision;
    }
  }, { name: "awaitApproval" });
}

export async function sendApproval(workflowId: string, decision: Decision, operationKey: string): Promise<void> {
  await DBOS.send(workflowId, decision, "approval", operationKey);
}
