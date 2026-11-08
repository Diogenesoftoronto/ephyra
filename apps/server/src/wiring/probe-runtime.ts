import { createHash } from "node:crypto";
import { ReconciliationRequired, Unverified, type OperationLedger, type Runner, type ServiceProfile, type Trail } from "@ephyra/core";
import type { AgentDeps } from "./agents.ts";
import type { ServerContext } from "./context.ts";
import { WorkControl } from "./control.ts";
import { executeProbe, type ProbeDefinition, type ProbeReceipt } from "./probes.ts";
import { recordTrailUsage, workBudget } from "./budget.ts";

export type IsolatedProbeOptions = {
  ctx: ServerContext; runner: Runner | null; profile: ServiceProfile; ledger: OperationLedger; control: WorkControl;
  prepare?: AgentDeps["prepareProof"]; secrets?: string[]; timeoutS: number;
};

/** The same actual isolated execution supplies intent updates and production-watch probes. */
export function isolatedProbeRunner(options: IsolatedProbeOptions) {
  return async (probe: ProbeDefinition, trail: Trail, operationKey: string): Promise<ProbeReceipt> => {
    const { ctx, runner, ledger, profile, control } = options;
    if (!runner) throw new Unverified("isolated probe runner");
    const budget = workBudget(trail, options.timeoutS);
    if (budget.reason) throw new Unverified(budget.reason);
    const key = `probe-execution:${createHash("sha256").update(operationKey).digest("hex")}`;
    const plan = createHash("sha256").update(JSON.stringify({ repo: ctx.repo.id, trail: trail.id, rev: trail.rev,
      base: trail.base.sha, head: trail.head ?? null, source: probe.source, command: probe.command ?? null,
      script: probe.script ?? null, profile })).digest("hex");
    const claim = await ledger.begin(key, plan);
    if (!claim.fresh) {
      if (claim.record.status !== "done") throw new ReconciliationRequired(key, "Probe execution needs reconciliation.");
      const saved = claim.record.result as { receipt?: ProbeReceipt; unavailable?: boolean };
      if (!saved.receipt || saved.unavailable) throw new Unverified("recorded probe execution is unavailable");
      return saved.receipt;
    }
    const started = Date.now();
    let dispatched = false;
    try {
      const receipt = await control.run(trail.id, runner, async (active, signal) => {
        const commit = trail.head ?? trail.base.sha;
        const handle = await active.allocate({ trail, attempt: 1, repoUrl: ctx.repo.url, commit, profile,
          leaseS: Math.ceil(budget.wallclockS) + 60, operationKey: `${key}:sandbox` });
        try {
          const remainingMs = () => {
            signal.throwIfAborted();
            const ms = budget.wallclockS * 1000 - (Date.now() - started);
            if (ms <= 0) throw new Unverified("isolated probe deadline");
            return ms;
          };
          const prepare = await options.prepare?.(active, handle, { ...trail, head: commit });
          await prepare?.({ cwd: ".", commit, remainingMs: remainingMs() });
          dispatched = true;
          return await executeProbe(probe, { runner: active, handle, remainingMs, secrets: options.secrets });
        } finally { await active.destroy(handle); }
      });
      await ledger.complete(key, { receipt });
      return receipt;
    } catch (error) {
      if (error instanceof ReconciliationRequired || dispatched) {
        await ledger.markAmbiguous(key, "The probe or sandbox outcome needs reconciliation.");
        throw new ReconciliationRequired(key, "The probe or sandbox outcome needs reconciliation.");
      }
      await ledger.complete(key, { unavailable: true });
      throw error;
    } finally {
      await recordTrailUsage(ctx, trail.id, `${key}:execution-time`, { tokens: 0, costMicrousd: 0, wallMs: Date.now() - started });
    }
  };
}
