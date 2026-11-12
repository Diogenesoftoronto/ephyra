// Landing, rebase, the post-landing watch and rollback.
// The patch head must already carry Ephyra-Trail and Ephyra-Proof trailers for the accepted proof; if it does
// not, a trailer commit is added on top (same tree) so the landed commit is bound to its proof.
import { ReconciliationRequired, Unverified, type ForgeAdapter, type LandingReceipt,
  type Trail, type TrailEvent, type WatchConfig } from "@ephyra/core";
import { LandingReceipt as LandingReceiptSchema } from "@ephyra/core";
import { evaluateWatch } from "@ephyra/policy";
import { WatchCollector, type WatchState } from "@ephyra/evidence";
import { latestProofDigest } from "./human.ts";
import type { HandlerSlice, ServerContext } from "./context.ts";

export type Git = (args: string[], opts?: { input?: string; env?: Record<string, string> }) => Promise<string>;

export type WatchPreparation = {
  baseline: WatchConfig["baseline"];
  areaProbes: string[];
  observedAt: string;
  /** Recorded origin/window/coverage of the measurements, never a guessed baseline. */
  evidence: string;
};
export type DeploymentObservation = { sha: string; observedAt: string; source: string; deployedAt?: string };
export type WatchCoverage = { source: string; observedAt: string; gaps: string[] };
export type LandingWatch = {
  prepare(trail: Trail): Promise<WatchPreparation>;
  /** Refresh and ingest actual scoped telemetry before counts are read. Empty exception data is not complete instrumentation. */
  coverage(trail: Trail, since: string): Promise<WatchCoverage>;
  /** Return null until this exact remote landing is observed in the running application. */
  deployed(trail: Trail, receipt: LandingReceipt): Promise<DeploymentObservation | null>;
  runProbe(id: string, trail: Trail, operationKey: string): Promise<"pass" | "fail" | "unavailable">;
};

export type LandingDeps = {
  /** Adapter for each landing mode name (plain git handles trail_ref and auto_land). */
  adapters: ForgeAdapter[];
  /** git against the workspace repository (repo.mirrorDir). */
  git: Git;
  /** How often to observe a watching trail. */
  watchEveryMs: number;
  /** Personal workspaces require verified remote authority and watch coverage before a landing effect can write. */
  canLand?: () => Promise<boolean>;
  watch?: LandingWatch;
  /** Refresh the authorized remote branch and return the full actual commit now in the mirror. */
  refreshBase?: () => Promise<string>;
};

type WatchPayload = {
  trailId: string; rev: number; config: WatchConfig; receipt: LandingReceipt;
  state?: WatchState; tick: number; prepared: WatchPreparation; activationDeadline: string;
  activated?: boolean;
};

/** Measure only attributable routes. With no routes the rate criterion is explicitly inapplicable. */
export async function measureWatchBaseline(ctx: ServerContext, trail: Trail, areaProbes: string[], windowS = 900): Promise<WatchPreparation> {
  if (!Number.isInteger(windowS) || windowS < 1 || windowS > 86400) throw new Error("invalid baseline window");
  const now = ctx.clock.now();
  const from = new Date(now.getTime() - windowS * 1000);
  const signals = await Promise.all(trail.signals.map(id => ctx.signals.get(id)));
  if (signals.some(signal => !signal) || !signals.length) throw new Unverified("watch signal coverage");
  const routes = [...new Set(signals.flatMap(signal => signal?.route ? [signal.route] : []))];
  const samples = [];
  for (const route of routes) {
    const sample = await ctx.signals.errorRate(route, from, now);
    if (!sample || !Number.isFinite(sample.errors) || !Number.isFinite(sample.requests)
      || sample.requests <= 0 || sample.errors < 0 || sample.errors > sample.requests) {
      throw new Unverified("measured pre-landing route baseline");
    }
    samples.push({ route, ...sample });
  }
  const requests = samples.reduce((total, sample) => total + sample.requests, 0);
  const errors = samples.reduce((total, sample) => total + sample.errors, 0);
  return {
    baseline: { errorRate: requests ? errors / requests : 0 }, areaProbes,
    observedAt: now.toISOString(),
    evidence: JSON.stringify({ from: from.toISOString(), to: now.toISOString(), samples,
      errorRateApplicability: routes.length ? "measured" : "no attributable routes" }),
  };
}

async function journalFiles(ctx: ServerContext, trail: Trail, files: Record<string, string>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.journal.read(trail.id);
    if (!current || current.trail.rev !== trail.rev || current.trail.head !== trail.head || current.trail.state !== trail.state) return false;
    try { await ctx.journal.append(trail.id, current.head, current.trail, [], files); return true; }
    catch (error) { if ((error as Error)?.name !== "JournalConflict") throw error; }
  }
  throw new Error("watch evidence journal changed concurrently");
}

async function recordReceipts(ctx: ServerContext, trail: Trail, operationKey: string, receipts: LandingReceipt[]): Promise<void> {
  const name = Buffer.from(operationKey).toString("base64url");
  const content = JSON.stringify({ rev: trail.rev, head: trail.head, receipts }, null, 2);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.journal.read(trail.id);
    if (!current) throw new Error("landed operation has no trail journal");
    const files: Record<string, string> = { [`landing/operations/${name}.json`]: content };
    if (current.trail.rev === trail.rev && current.trail.head === trail.head) {
      files["landing/receipts.json"] = JSON.stringify(receipts, null, 2);
    }
    try { await ctx.journal.append(trail.id, current.head, current.trail, [], files); return; }
    catch (error) { if ((error as Error)?.name !== "JournalConflict") throw error; }
  }
  throw new ReconciliationRequired(operationKey, "The remote landing succeeded but its journal receipt needs reconciliation.");
}

function validPreparation(value: WatchPreparation, now: Date): boolean {
  const at = Date.parse(value.observedAt);
  return Number.isFinite(at) && at <= now.getTime() + 5000 && at >= now.getTime() - 900_000
    && Number.isFinite(value.baseline.errorRate) && value.baseline.errorRate >= 0 && value.baseline.errorRate <= 1
    && value.areaProbes.every(id => typeof id === "string" && id.length > 0 && id.length <= 300)
    && Boolean(value.evidence.trim()) && value.evidence.length <= 64_000;
}

function validCoverage(value: WatchCoverage, now: Date, since: string): boolean {
  const at = Date.parse(value.observedAt);
  return Number.isFinite(at) && at >= Date.parse(since) && at <= now.getTime() + 5000 && at >= now.getTime() - 60_000
    && typeof value.source === "string" && value.source.trim().length > 0 && value.source.length <= 500
    && Array.isArray(value.gaps) && value.gaps.length <= 100
    && value.gaps.every(gap => typeof gap === "string" && gap.length > 0 && gap.length <= 500);
}

/** The policy's watch window in seconds. The policy grammar allows s, m, h and d; all four are honoured here. */
export function parseWindow(text: string | undefined): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(text?.trim() ?? "");
  if (!m) return 7200;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
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
  const actor = { kind: "system" as const, id: "watch" };
  let deployed: DeploymentObservation | null = null;
  try { deployed = await deps.watch?.deployed(trail, payload.receipt) ?? null; } catch { /* observed as an attribution gap below */ }
  const deployedAt = deployed ? Date.parse(deployed.observedAt) : NaN;
  const now = ctx.clock.now();
  const attributed = deployed?.sha === payload.receipt.newOid && Boolean(deployed.source.trim())
    && Number.isFinite(deployedAt) && deployedAt <= now.getTime() + 5000
    && deployedAt >= Date.parse(payload.receipt.at) && deployedAt >= now.getTime() - 60_000;
  if (!attributed) {
    await journalFiles(ctx, trail, { "watch/latest.json": JSON.stringify({ status: "awaiting_deployment",
      expected: payload.receipt.newOid, coverageGaps: ["exact deployed revision unavailable"], observedAt: now.toISOString() }) });
    if (now.getTime() >= Date.parse(payload.activationDeadline)) {
      await ctx.emit({ trail: trail.id, actor, type: "parked", data: { reason: "The landed revision could not be attributed to a deployment." } });
      return;
    }
    await scheduleObservation(ctx, deps, trail, { ...payload,
      ...(payload.state ? { state: { ...payload.state, aboveSince: null } } : {}) });
    return;
  }
  if (!payload.activated) {
    const activatedAt = deployed!.deployedAt ? Date.parse(deployed!.deployedAt) : deployedAt;
    if (!Number.isFinite(activatedAt) || activatedAt > deployedAt + 5000) throw new Unverified("deployment activation time");
    payload.config.startedAt = new Date(Math.max(Date.parse(payload.receipt.at), activatedAt)).toISOString();
    payload.activated = true;
    await ctx.emit({ trail: trail.id, actor, type: "watch_started", data: { config: payload.config } });
  }
  let coverage: WatchCoverage | null = null;
  const coverageGaps: string[] = [];
  try {
    coverage = await deps.watch!.coverage(trail, payload.config.startedAt);
    if (!validCoverage(coverage, ctx.clock.now(), payload.config.startedAt)) throw new Unverified("fresh scoped telemetry coverage");
    coverageGaps.push(...coverage.gaps);
  } catch { coverageGaps.push("fresh scoped telemetry coverage unavailable"); }
  const { observations, state } = await new WatchCollector().collect(payload.config, {
    signals: ctx.signals, clock: ctx.clock,
    runProbe: id => deps.watch!.runProbe(id, trail, `watch:${trail.id}:${trail.rev}:${payload.tick}:${id}`), errorRateMultiplier: 1.5,
    ...(payload.state ? { state: { ...payload.state, ...(coverageGaps.length ? { aboveSince: null } : {}) } } : {}),
  });
  observations.coverageGaps.push(...coverageGaps);
  if (coverageGaps.length) {
    state.aboveSince = null;
    if (observations.errorRate) observations.errorRate.sustainedAboveS = 0;
  }
  const verdict = evaluateWatch(payload.config, observations, trail.risk);
  const record = JSON.stringify({ config: payload.config, observations, state, deployed, coverage, prepared: payload.prepared }, null, 2);
  if (!await journalFiles(ctx, trail, { "watch/latest.json": record, [`watch/observations/${payload.tick}.json`]: record })) return;
  if (verdict.rollback) {
    await ctx.emit({ trail: trail.id, actor, type: "probe_regressed_after_landing",
      data: { criterion: verdict.criterion, evidence: JSON.stringify(observations).slice(0, 3000) } });
    return;
  }
  if (verdict.canClose) {
    await ctx.emit({ trail: trail.id, actor, type: "watch_completed", data: { outcome: "clean" },
      files: { "watch.json": record } });
    return;
  }
  // Missing telemetry may extend observation briefly, but never become an endless successful-looking watch.
  if (observations.elapsedS > payload.config.windowS + 3600) {
    await ctx.emit({ trail: trail.id, actor, type: "parked", data: { reason: "Post-landing watch has unresolved coverage gaps." } });
    return;
  }
  await scheduleObservation(ctx, deps, trail, { ...payload, state });
}

async function scheduleObservation(ctx: ServerContext, deps: LandingDeps, trail: Trail, payload: WatchPayload): Promise<void> {
  const next = payload.tick + 1;
  await ctx.jobs.enqueue("watch", `watch:${trail.id}:${trail.rev}:${next}`, { ...payload, tick: next },
    { runAt: new Date(ctx.clock.now().getTime() + deps.watchEveryMs) });
}

export function landingHandlers(ctx: ServerContext, deps: LandingDeps): HandlerSlice {
  ctx.jobs.register("watch", (payload) => observe(ctx, deps, payload as WatchPayload));
  const actor = { kind: "system" as const, id: "landing" };

  return {
    land: async (effect, trail) => {
      if (!deps.watch || deps.canLand && !await deps.canLand()) {
        await ctx.emit({ trail: trail.id, actor, type: "parked", data: {
          reason: "Remote landing authority and post-landing watch coverage must be verified before this patch can land.",
        } });
        return;
      }
      const events: TrailEvent[] = await ctx.trails.events(trail.id);
      const digest = latestProofDigest(trail, events);
      const approval = trail.checkpoints.C;
      if (!digest || !trail.head || !approval || approval.verdict !== "approve" || approval.shadow) {
        await ctx.emit({ trail: trail.id, actor, type: "landing_failed", data: { reason: "no approved proof to land", baseMoved: false } });
        return;
      }
      if ((trail.risk === "critical" && effect.modes.some(mode => mode === "auto_land" || mode === "devenv_live"))
        || (["high", "critical"].includes(trail.risk) && (approval.by !== "human" || !approval.who?.trim()))) {
        await ctx.emit({ trail: trail.id, actor, type: "parked", data: {
          reason: "High and critical changes require named human C approval; critical changes cannot auto-land or apply live.",
        } });
        return;
      }
      let prepared: WatchPreparation;
      try {
        const since = new Date(ctx.clock.now().getTime() - 900_000).toISOString();
        const coverage = await deps.watch.coverage(trail, since);
        if (!validCoverage(coverage, ctx.clock.now(), since) || coverage.gaps.length) throw new Unverified("pre-landing telemetry coverage");
        prepared = await deps.watch.prepare(trail);
        if (!validPreparation(prepared, ctx.clock.now())) throw new Unverified("fresh measured watch preparation");
      } catch {
        await ctx.emit({ trail: trail.id, actor, type: "parked", data: {
          reason: "Post-landing watch needs a measured baseline and configured probe coverage before remote writes.",
        } });
        return;
      }
      if (!await journalFiles(ctx, trail, { "watch/preparation.json": JSON.stringify({ ...prepared,
        rev: trail.rev, head: trail.head, base: trail.base.sha }, null, 2) })) return;
      const bound = await bindHead(deps.git, trail, digest);
      const landed: Trail = { ...trail, head: bound };
      const authorizationId = `${trail.id}:C:${approval.at}`;
      const receipts: LandingReceipt[] = [];
      for (const [i, mode] of effect.modes.entries()) {
        const adapter = adapterFor(deps, mode);
        try {
          const current = await ctx.trails.get(trail.id);
          if (!current || current.state !== "landing" || current.rev !== trail.rev || current.head !== trail.head
            || current.checkpoints.C?.at !== approval.at) return;
          const plan = await adapter.prepareLanding(landed, mode, trail.base.sha, digest);
          const receipt: LandingReceipt = await adapter.land(plan, authorizationId, `forge:${effect.key}:${i}`);
          receipts.push(receipt);
          await recordReceipts(ctx, trail, effect.key, receipts);
          const after = await ctx.trails.get(trail.id);
          if (!after || after.state !== "landing" || after.rev !== trail.rev || after.head !== trail.head) return;
          ctx.log("landed", { trail: trail.short, mode, target: receipt.target, oid: receipt.newOid });
          if (i === effect.modes.length - 1) {
            await ctx.emit({ trail: trail.id, actor, type: "landing_completed", data: { receipt } });
          }
        } catch (error) {
          if (error instanceof ReconciliationRequired) throw error;
          const baseMoved = (error as Error)?.name === "BaseMoved" || String(error).includes("BaseMoved");
          if (baseMoved) {
            const onto = await deps.refreshBase?.();
            if (onto && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(onto) && onto !== trail.base.sha) {
              await ctx.emit({ trail: trail.id, actor, type: "base_moved", data: { newSha: onto, overlapsTouchedFiles: true } });
            } else {
              await ctx.emit({ trail: trail.id, actor, type: "parked", data: {
                reason: "The remote base moved; refresh the authorized branch before rebasing this patch.",
              } });
            }
            return;
          }
          await ctx.emit({ trail: trail.id, actor, type: "landing_failed",
            data: { reason: "The configured forge rejected this landing; inspect its operation receipt.", baseMoved: false } });
          return;
        }
      }
    },
    rebase: async (effect, trail) => {
      const current = await ctx.trails.get(trail.id);
      if (!current || current.state !== "patching" || current.rev !== trail.rev || current.base.sha !== effect.onto) return;
      await ctx.jobs.enqueue("agent_step", `${effect.key}:patch`, {
        trailId: trail.id, rev: trail.rev, step: "patch", operationKey: effect.key,
        generation: trail.workGeneration ?? 0,
        note: `Rebase the existing patch onto exact base ${effect.onto}. Resolve conflicts within the authorized scope, `
          + "retain the original objective and produce a new commit. Previous proof and approval do not apply to this base.",
      });
    },
    start_watch: async (effect, trail) => {
      if (!deps.watch) throw new Unverified("post-landing watch port");
      const raw = await ctx.journal.readFile(trail.id, "watch/preparation.json");
      if (!raw) throw new Unverified("recorded pre-landing watch baseline");
      const prepared = JSON.parse(new TextDecoder().decode(raw)) as WatchPreparation & { rev: number; head: string; base: string };
      if (prepared.rev !== trail.rev || prepared.head !== trail.head || prepared.base !== trail.base.sha) {
        throw new Unverified("watch preparation revision binding");
      }
      const receipt = trail.landing?.receipts.at(-1);
      if (!receipt) throw new Unverified("actual landing receipt for watch");
      const area = ctx.policy.autonomy.areas.find((a) => a.name === trail.area);
      const windowS = parseWindow(area?.watch ?? ctx.policy.autonomy.defaults.watch);
      const fingerprints = (await Promise.all(trail.signals.map((id) => ctx.signals.get(id))))
        .flatMap((s) => (s ? [s.fingerprint] : []));
      const routes = (await Promise.all(trail.signals.map((id) => ctx.signals.get(id))))
        .flatMap((s) => (s?.route ? [s.route] : []));
      const config: WatchConfig = {
        windowS, fingerprints: [...new Set(fingerprints)], touchedFiles: await touchedFiles(deps.git, trail),
        routes: [...new Set(routes)], areaProbes: prepared.areaProbes, baseline: prepared.baseline,
        startedAt: ctx.clock.now().toISOString(),
      };
      await ctx.jobs.enqueue("watch", `watch:${trail.id}:${trail.rev}:0`, {
        trailId: trail.id, rev: trail.rev, config, tick: 0, receipt, prepared,
        activationDeadline: new Date(ctx.clock.now().getTime() + 900_000).toISOString(),
      } satisfies WatchPayload,
        { runAt: new Date(ctx.clock.now().getTime() + deps.watchEveryMs) });
      void effect;
    },
    rollback: async (effect, trail) => {
      const raw = await ctx.journal.readFile(trail.id, "landing/receipts.json");
      const recorded: unknown = raw ? JSON.parse(new TextDecoder().decode(raw)) : trail.landing?.receipts;
      if (!Array.isArray(recorded) || !recorded.length) throw new Error("nothing landed to roll back");
      const receipts = recorded.map(value => LandingReceiptSchema.parse(value));
      const reverted: LandingReceipt[] = [];
      // The executor already holds `effect.key` in the shared ledger; the adapter gets its own key.
      for (const [index, receipt] of receipts.reverse().entries()) {
        reverted.push(await adapterFor(deps, receipt.mode).revert(receipt, `forge:${effect.key}:${index}`));
        await journalFiles(ctx, trail, { "landing/rollback-receipts.json": JSON.stringify(reverted, null, 2) });
      }
      await ctx.emit({ trail: trail.id, actor, type: "rollback_completed", data: { receipt: reverted.at(-1)! } });
    },
    resume_dependents: async (_effect, trail) => {
      const waiting = (await ctx.trails.list({ states: ["parked"] })).filter((t) => t.parent === trail.id && t.waitingForParent);
      for (const child of waiting) {
        await ctx.emit({ trail: child.id, actor, type: "parent_trail_landed", data: { parent: trail.id } });
      }
    },
  };
}
