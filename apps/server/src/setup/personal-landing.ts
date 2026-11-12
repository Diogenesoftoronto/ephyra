import { Unverified } from "@ephyra/core";
import { HostedPullAdapter, RemoteGitAdapter, hostedProviderFor, type HostedPullOptions } from "@ephyra/forge";
import type { ForgeAdapter } from "@ephyra/core";
import type { ComposeOverrides } from "../compose.ts";
import type { Accounts } from "./accounts.ts";
import { canonicalJson } from "../audit.ts";
import { measureWatchBaseline } from "../wiring/landing.ts";

/** Personal writes use current account credentials at the constrained HTTPS edge, never deployment Git identity. */
export function personalLanding(options: {
  accounts: Accounts; did: string; workspace: string;
  /** Tests inject a fake; production builds the real adapter. */
  hosted?: (options: HostedPullOptions) => ForgeAdapter;
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
      const requestedAt = ctx.clock.now().getTime();
      const result = await telemetry?.poll({ since });
      const measured = result?.coverage;
      const gaps = [...measured?.gaps ?? []];
      if (result?.status !== "complete" || measured?.complete !== true) gaps.push(`PostHog coverage ${result?.status ?? "unavailable"}`);
      const through = measured?.computedThrough ? Date.parse(measured.computedThrough) : NaN;
      if (!Number.isFinite(through) || through < Date.parse(since) || through < requestedAt - 1000) {
        gaps.push("PostHog computation has not covered the current watch observation window.");
      }
      if (!measured?.windowSince || Date.parse(measured.windowSince) > Date.parse(since)) {
        gaps.push("PostHog query did not cover the complete requested watch history.");
      }
      if (_trail.state === "watching") {
        const autonomy = ctx.policy.autonomy;
        const window = autonomy?.areas.find(area => area.name === _trail.area)?.watch ?? autonomy?.defaults.watch;
        const duration = /^(\d+)\s*(m|h|d)$/.exec(window?.trim() ?? "");
        const windowMs = duration ? Number(duration[1]) * { m: 60_000, h: 3600_000, d: 86400_000 }[duration[2] as "m" | "h" | "d"] : NaN;
        const requiredEnd = Date.parse(since) + windowMs;
        if (!Number.isFinite(requiredEnd) || requestedAt >= requiredEnd && through < requiredEnd) {
          gaps.push("PostHog computation has not covered the required watch end.");
        }
      }
      return { source: result?.source ?? "posthog:unavailable", observedAt: measured?.computedThrough ?? "",
        gaps: [...new Set(gaps)] };
    };
    const adapter = new RemoteGitAdapter(ctx.repo.mirrorDir, { remote, scope: `${did}:${workspace}`, ledger, authorize,
      run: (argv) => accounts.repositoryCommand(did, workspace, argv) });
    const adapters: ForgeAdapter[] = [adapter];
    // A pull request needs the forge's API, so it needs a saved token. Without one, pull_request has no adapter and parks.
    const provider = ["github", "gitlab", "forgejo"].includes(repository.forge?.kind ?? "") && repository.credentialConfigured
      ? hostedProviderFor(remote, repository.forge?.kind === "gitlab" ? { gitlabHosts: [new URL(remote).hostname] } : {})
      : null;
    if (provider) {
      adapters.push((options.hosted ?? ((o) => new HostedPullAdapter(o)))({
        ...provider, baseBranch: repository.branch.replace(/^refs\/heads\//, ""), repoDir: ctx.repo.mirrorDir, remote,
        scope: `${did}:${workspace}`, ledger, authorize,
        token: () => accounts.repositoryToken(did, workspace, repository),
        run: (argv) => accounts.repositoryCommand(did, workspace, argv),
      }));
    }
    return { adapters, canLand, refreshBase: () => accounts.refreshRepository(did, workspace), watch: {
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
