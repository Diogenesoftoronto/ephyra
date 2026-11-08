import { join } from "node:path";
import { Unverified, type AccountSettings, type ServiceProfile } from "@ephyra/core";
import { ArtifactStore, FileRailwayLeaseStore, RailwaySandboxRunner, createRailwaySandboxClient } from "@ephyra/runner";
import type { Config } from "../config.ts";
import type { DraftModel } from "../velum.ts";
import type { ServerContext } from "../wiring/context.ts";
import { AccountCodingAgent } from "./coding-agent.ts";
import { KnowledgeOperationLedger } from "./knowledge-ledger.ts";
import { repositoryBundle } from "./repository-bundle.ts";

export function hostingStatus(config: Config, did: string): NonNullable<AccountSettings["automation"]> {
  const accounts = config.EPHYRA_HOSTED_ACCOUNTS.split(",").map((s) => s.trim());
  const allowed = accounts.includes(did) || accounts.includes("*");
  const configured = config.EPHYRA_HOSTED_RUNNER === "railway" && allowed
    && Boolean(config.EPHYRA_RAILWAY_TOKEN && config.EPHYRA_RAILWAY_ENVIRONMENT_ID);
  return { provider: config.EPHYRA_HOSTED_RUNNER, configured, detail: configured
    ? "Automatic setup provisions an isolated Railway sandbox and uses your selected account model."
    : "Hosted execution needs an operator-provided Railway environment and an account grant." };
}

export async function hostedAutomation(config: Config, scope: { did: string; workspaceId: string; directory: string },
  model: () => Promise<DraftModel | null>) {
  if (!hostingStatus(config, scope.did).configured) return null;
  const ledger = new KnowledgeOperationLedger(join(scope.directory, "hosted-operations"));
  const leases = new FileRailwayLeaseStore(join(scope.directory, "hosted-leases"));
  const client = createRailwaySandboxClient({ token: config.EPHYRA_RAILWAY_TOKEN!, environmentId: config.EPHYRA_RAILWAY_ENVIRONMENT_ID!,
    image: config.EPHYRA_RAILWAY_CHECKPOINT ? { kind: "checkpoint", name: config.EPHYRA_RAILWAY_CHECKPOINT } : { kind: "default" },
    idleTimeoutMinutes: config.EPHYRA_RAILWAY_IDLE_MINUTES,
    ...(config.EPHYRA_RAILWAY_REGION ? { region: config.EPHYRA_RAILWAY_REGION } : {}) });
  let jobs: ServerContext["jobs"] | undefined;
  const runner = new RailwaySandboxRunner(new ArtifactStore(join(scope.directory, "artifacts")), client, {
    ledger, leaseStore: leases, scope: `${scope.did}:${scope.workspaceId}`,
    repositoryBundle: ({ commit, base }) => repositoryBundle(join(scope.directory, "workspace.git"), commit, base && base !== commit ? [base] : []),
    onLease: async (handle) => jobs?.enqueue("hosted_cleanup", `hosted-cleanup:${handle.id}`, { handleId: handle.id, followup: 0 },
      { runAt: new Date(handle.leaseExpiresAt) }),
  });
  const profile: ServiceProfile = { name: "railway-account", digest: "railway-account-v1", network: "egress", readOnlyProd: true,
    credentials: [], limits: { cpu: config.EPHYRA_RAILWAY_CPU, memoryMb: config.EPHYRA_RAILWAY_MEMORY_MB,
      diskMb: 0, timeoutS: config.EPHYRA_STEP_TIMEOUT_S } };
  return { runner, profile, ledger, agent: new AccountCodingAgent({ model, ledger }),
    async attach(ctx: ServerContext) {
      jobs = ctx.jobs;
      jobs.register("hosted_cleanup", async (payload) => {
        const followup = Number((payload as { followup?: number }).followup ?? 0);
        for (const receipt of await runner.reapExpired()) {
          ctx.log("hosted sandbox cleanup", receipt);
          if (receipt.status !== "reconciliation_required") continue;
          if (followup >= 2) throw new Unverified("Hosted sandbox cleanup still requires reconciliation; inspect hosted-leases and the provider.");
          await jobs!.enqueue("hosted_cleanup", `hosted-cleanup:${receipt.handleId}:followup:${followup + 1}`,
            { handleId: receipt.handleId, followup: followup + 1 }, { runAt: new Date(Date.now() + 60_000) });
        }
      });
      for (const lease of await leases.list()) {
        await jobs.enqueue("hosted_cleanup", `hosted-cleanup:${lease.handle.id}`, { handleId: lease.handle.id, followup: 0 },
          { runAt: new Date(lease.handle.leaseExpiresAt) });
      }
    },
  };
}
