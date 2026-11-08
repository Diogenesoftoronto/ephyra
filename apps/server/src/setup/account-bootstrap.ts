import type { BootstrapCoverage, SetupRun } from "@ephyra/core";
import type { Accounts } from "./accounts.ts";

/** Cheap, selected-source observations. No model call, runner allocation, or broad knowledge search occurs here. */
export async function accountBootstrapCoverage(
  accounts: Pick<Accounts, "record" | "peopleFor" | "deploymentFor">,
  did: string, workspace: string, run: SetupRun,
): Promise<BootstrapCoverage[]> {
  const record = await accounts.record(did);
  if (record.settings.workspaceId !== workspace) throw new Error("Bootstrap workspace changed");
  const settings = record.settings;
  const knowledge = settings.knowledge;
  const selected = knowledge?.enabled && knowledge.workspaceId === workspace ? knowledge.sources : [];
  const coverage: BootstrapCoverage[] = [{ id: "knowledge", status: selected.length ? "configured" : "missing", references: [],
    summary: selected.length
      ? `${selected.length} knowledge source${selected.length === 1 ? " is" : "s are"} selected. Bootstrap has not fetched their content.`
      : "No project knowledge source is selected. Repository documents and owner answers can supply initial context." }];
  const people = await accounts.peopleFor(did, workspace);
  const owner = people?.settings.contacts.some(contact => contact.did === did);
  coverage.push({ id: "contact", status: owner ? "observed" : people ? "configured" : "missing", references: owner ? ["owner-inbox"] : [],
    summary: owner ? "Your authenticated owner inbox can receive setup requests. External delivery has not been tested."
      : people ? "Contacts are configured. No delivery receipt establishes that a recipient can be reached."
        : "Contact is disabled. Open setup to review the recorded requests or enable an owner contact." });
  const deploymentUrl = settings.telemetry?.enabled && settings.telemetry.workspaceId === workspace
    ? settings.telemetry.deploymentUrl : undefined;
  if (!deploymentUrl) coverage.push({ id: "deployment", status: "missing", references: [],
    summary: "Connect a deployment receipt endpoint to identify the running repository revision." });
  else {
    try {
      const receipt = await accounts.deploymentFor(did, workspace, run.repository.head);
      coverage.push({ id: "deployment", status: receipt ? "observed" : "configured", references: [deploymentUrl],
        ...(receipt ? { checkedAt: receipt.observedAt } : {}), summary: receipt
          ? `The deployment receipt reports this repository's exact setup commit ${receipt.sha}.`
          : "The receipt endpoint is configured, but it has not established that the setup commit is deployed." });
    } catch { coverage.push({ id: "deployment", status: "unknown", references: [deploymentUrl],
      summary: "The deployment receipt could not be verified for this repository and branch." }); }
  }
  if ((await accounts.record(did)).settings.workspaceId !== workspace) throw new Error("Bootstrap workspace changed");
  return coverage;
}
