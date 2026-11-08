import { Unverified } from "@ephyra/core";
import { RemoteGitAdapter } from "@ephyra/forge";
import type { ComposeOverrides } from "../compose.ts";
import type { Accounts } from "./accounts.ts";
import { canonicalJson } from "../audit.ts";
import { measureWatchBaseline } from "../wiring/landing.ts";

/** Personal writes use current account credentials at the constrained HTTPS edge, never deployment Git identity. */
export function personalLanding(options: {
  accounts: Accounts; did: string; workspace: string;
}): NonNullable<ComposeOverrides["landing"]> {
  return async ({ ctx, ledger, probes, runProbe, telemetry }) => {
    const { accounts, did, workspace } = options;
    const record = await accounts.record(did);
    const repository = record.settings.repository;
    if (!repository || repository.forge?.kind === "radicle") return { adapters: [] };
    const remote = repository.forge?.cloneUrl ?? repository.url;
    const authorize = async () => {
      const fresh = await accounts.record(did);
      if (fresh.settings.workspaceId !== workspace || canonicalJson(fresh.settings.repository) !== canonicalJson(repository))
        throw new Unverified("current repository write authority");
    };
    const canLand = async () => {
      await authorize();
      const fresh = await accounts.record(did);
      const connection = fresh.settings.telemetry;
      return Boolean(telemetry && connection?.enabled && connection.workspaceId === workspace && connection.deploymentUrl);
    };
    const coverage = async (_trail: Parameters<typeof measureWatchBaseline>[1], since: string) => {
      await authorize();
      const result = await telemetry?.poll({ since });
      return { source: result?.source ?? "posthog:unavailable", observedAt: ctx.clock.now().toISOString(),
        gaps: result?.status === "complete" ? [] : [`PostHog coverage ${result?.status ?? "unavailable"}`] };
    };
    const adapter = new RemoteGitAdapter(ctx.repo.mirrorDir, { remote, scope: `${did}:${workspace}`, ledger, authorize,
      run: (argv) => accounts.repositoryCommand(did, workspace, argv) });
    return { adapters: [adapter], canLand, refreshBase: () => accounts.refreshRepository(did, workspace), watch: {
      coverage,
      prepare: async (trail) => {
        if (!await canLand()) throw new Unverified("configured deployment and telemetry sources");
        const applicable = await probes.list(trail);
        return measureWatchBaseline(ctx, trail, applicable.map(probe => probe.id));
      },
      deployed: (_trail, receipt) => accounts.deploymentFor(did, workspace, receipt.newOid),
      runProbe: async (id, trail, operationKey) => {
        await authorize();
        const probe = (await probes.list(trail)).find(candidate => candidate.id === id);
        const receipt = trail.landing?.receipts.at(-1);
        if (!probe || !receipt) return "unavailable";
        const result = await runProbe(probe, { ...trail, head: receipt.newOid }, operationKey);
        return result.result;
      },
    } };
  };
}
