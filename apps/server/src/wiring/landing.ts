// Landing, rebase, the post-landing watch and rollback.
// The patch head must already carry Ephyra-Trail and Ephyra-Proof trailers for the accepted proof; if it does
// not, a trailer commit is added on top (same tree) so the landed commit is bound to its proof.
import type { ForgeAdapter, LandingReceipt, Trail, TrailEvent, WatchConfig } from "@ephyra/core";
import { evaluateWatch } from "@ephyra/policy";
import { WatchCollector, type WatchState } from "@ephyra/evidence";
import { latestProofDigest } from "./human.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";

export type Git = (args: string[], opts?: { input?: string; env?: Record<string, string> }) => Promise<string>;

export type LandingDeps = {
  /** Adapter for each landing mode name (plain git handles trail_ref and auto_land). */
  adapters: ForgeAdapter[];
  /** git against the workspace repository (repo.mirrorDir). */
  git: Git;
  /** How often to observe a watching trail. */
  watchEveryMs: number;
};

type WatchPayload = { trailId: string; rev: number; config: WatchConfig; state?: WatchState; tick: number };

function parseWindow(text: string | undefined): number {
  const m = /^(\d+)\s*(m|h|d)$/.exec(text?.trim() ?? "");
  if (!m) return 7200;
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"];
}

/** Add a trailer commit (same tree) binding the head to the proof, unless the head already carries it. */
async function bindHead(git: Git, trail: Trail, digest: string): Promise<string> {
  const head = trail.head!;
  const message = await git(["show", "-s", "--format=%B", head]);
  if (message.includes(`Ephyra-Trail: ${trail.id}`) && message.includes(`Ephyra-Proof: ${digest}`)) return head;
  const tree = (await git(["rev-parse", `${head}^{tree}`])).trim();
  const body = `ephyra: land ${trail.short} ${trail.title}\n\nEphyra-Trail: ${trail.id}\nEphyra-Proof: ${digest}\n`;
  const env = { GIT_AUTHOR_NAME: "ephyra", GIT_AUTHOR_EMAIL: "ephyra@localhost", GIT_COMMITTER_NAME: "ephyra", GIT_COMMITTER_EMAIL: "ephyra@localhost" };
  return (await git(["commit-tree", tree, "-p", head, "-F", "-"], { input: body, env })).trim();
}

async function touchedFiles(git: Git, trail: Trail): Promise<string[]> {
  if (!trail.head) return [];
  const out = await git(["diff", "--name-only", trail.base.sha, trail.head]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function adapterFor(deps: LandingDeps, mode: string): ForgeAdapter {
  const name = mode === "radicle_patch" ? "radicle" : mode === "tangled_pull" ? "tangled" : "plain-git";
  const adapter = deps.adapters.find((a) => a.name === name);
  if (!adapter) throw new Error(`no forge adapter for landing mode ${mode}`);
  return adapter;
}

async function observe(ctx: ServerContext, deps: LandingDeps, payload: WatchPayload): Promise<void> {
  const trail = await ctx.trails.get(payload.trailId);
  if (!trail || trail.state !== "watching" || trail.rev !== payload.rev) return;
  const { observations, state } = await new WatchCollector().collect(payload.config, {
    signals: ctx.signals, clock: ctx.clock, runProbe: async () => "unavailable", errorRateMultiplier: 1.5,
    ...(payload.state ? { state: payload.state } : {}),
  });
  const verdict = evaluateWatch(payload.config, observations, trail.risk);
  const actor = { kind: "system" as const, id: "watch" };
  if (verdict.rollback) {
    await ctx.emit({ trail: trail.id, actor, type: "probe_regressed_after_landing",
      data: { criterion: verdict.criterion, evidence: JSON.stringify(observations).slice(0, 3000) } });
    return;
  }
  if (verdict.canClose) {
    await ctx.emit({ trail: trail.id, actor, type: "watch_completed", data: { outcome: "clean" },
      files: { "watch.json": JSON.stringify({ config: payload.config, observations }, null, 2) } });
    return;
  }
  const next = payload.tick + 1;
  await ctx.jobs.enqueue("watch", `watch:${trail.id}:${trail.rev}:${next}`, { ...payload, state, tick: next },
    { runAt: new Date(ctx.clock.now().getTime() + deps.watchEveryMs) });
}

export function landingHandlers(ctx: ServerContext, deps: LandingDeps): HandlerSlice {
  ctx.jobs.register("watch", (payload) => observe(ctx, deps, payload as WatchPayload));
  const actor = { kind: "system" as const, id: "landing" };

  return {
    land: async (effect, trail) => {
      const events: TrailEvent[] = await ctx.trails.events(trail.id);
      const digest = latestProofDigest(trail, events);
      const approval = trail.checkpoints.C;
      if (!digest || !trail.head || !approval || approval.verdict !== "approve" || approval.shadow) {
        await ctx.emit({ trail: trail.id, actor, type: "landing_failed", data: { reason: "no approved proof to land", baseMoved: false } });
        return;
      }
      const bound = await bindHead(deps.git, trail, digest);
      const landed: Trail = { ...trail, head: bound };
      const authorizationId = `${trail.id}:C:${approval.at}`;
      for (const [i, mode] of effect.modes.entries()) {
        const adapter = adapterFor(deps, mode);
        try {
          const plan = await adapter.prepareLanding(landed, mode, trail.base.sha, digest);
          const receipt: LandingReceipt = await adapter.land(plan, authorizationId, `forge:${effect.key}:${i}`);
          ctx.log("landed", { trail: trail.short, mode, target: receipt.target, oid: receipt.newOid });
          if (i === effect.modes.length - 1) {
            await ctx.emit({ trail: trail.id, actor, type: "landing_completed", data: { receipt } });
          }
        } catch (error) {
          const baseMoved = (error as Error)?.name === "BaseMoved" || String(error).includes("BaseMoved");
          await ctx.emit({ trail: trail.id, actor, type: "landing_failed",
            data: { reason: String(error).slice(0, 500), baseMoved } });
          return;
        }
      }
    },
    rebase: async (effect, trail) => {
      // The patch agent rebases onto the new base as part of its next run.
      ctx.log("rebase requested", { trail: trail.short, onto: effect.onto });
    },
    start_watch: async (effect, trail) => {
      const area = ctx.policy.autonomy.areas.find((a) => a.name === trail.area);
      const windowS = parseWindow(area?.watch ?? ctx.policy.autonomy.defaults.watch);
      const fingerprints = (await Promise.all(trail.signals.map((id) => ctx.signals.get(id))))
        .flatMap((s) => (s ? [s.fingerprint] : []));
      const routes = (await Promise.all(trail.signals.map((id) => ctx.signals.get(id))))
        .flatMap((s) => (s?.route ? [s.route] : []));
      const config: WatchConfig = {
        windowS, fingerprints: [...new Set(fingerprints)], touchedFiles: await touchedFiles(deps.git, trail),
        routes: [...new Set(routes)], areaProbes: [], baseline: { errorRate: 0.01 },
        startedAt: ctx.clock.now().toISOString(),
      };
      await ctx.emit({ trail: trail.id, actor: { kind: "system", id: "watch" }, type: "watch_started", data: { config } });
      await ctx.jobs.enqueue("watch", `watch:${trail.id}:${trail.rev}:0`, { trailId: trail.id, rev: trail.rev, config, tick: 0 },
        { runAt: new Date(ctx.clock.now().getTime() + deps.watchEveryMs) });
      void effect;
    },
    rollback: async (effect, trail) => {
      const receipt = trail.landing?.receipts.at(-1);
      if (!receipt) throw new Error("nothing landed to roll back");
      // The executor already holds `effect.key` in the shared ledger; the adapter gets its own key.
      const reverted = await adapterFor(deps, receipt.mode).revert(receipt, `forge:${effect.key}`);
      await ctx.emit({ trail: trail.id, actor, type: "rollback_completed", data: { receipt: reverted } });
    },
    register_regression_probe: async (_effect, trail) => {
      ctx.log("regression probe registered", { trail: trail.short });
    },
    resume_dependents: async (_effect, trail) => {
      const waiting = (await ctx.trails.list({ states: ["parked"] })).filter((t) => t.parent === trail.id && t.waitingForParent);
      for (const child of waiting) {
        await ctx.emit({ trail: child.id, actor, type: "parent_trail_landed", data: { parent: trail.id } });
      }
    },
  };
}
