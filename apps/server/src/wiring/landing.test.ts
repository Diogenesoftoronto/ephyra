import { expect, test } from "bun:test";
import fc from "fast-check";
import { ReconciliationRequired, type ForgeAdapter, type Journal, type SignalStore, type Trail, type TrailEvent } from "@ephyra/core";
import { AUTONOMY_TEMPLATE, parseAutonomy } from "@ephyra/policy";
import { FakeContext } from "./context.ts";
import { landingHandlers, measureWatchBaseline, type LandingDeps, type LandingWatch } from "./landing.ts";

const id = "019cc100-0000-7000-8000-000000000001";
const proof = `sha256:${"d".repeat(64)}`;
const head = "b".repeat(40);
const receipt = { mode: "auto_land" as const, target: "refs/heads/main", oldOid: "a".repeat(40), newOid: head,
  proofDigest: proof, at: "2026-11-08T10:00:00.000Z" };

function fixture() {
  let now = Date.parse("2026-11-08T10:00:01.000Z");
  const trail: Trail = { schema: 1, id, short: "T-000001", repo: "repo", title: "Repair", rev: 2, state: "landing",
    signals: ["019cc100-0000-7000-8000-000000000002"], area: "application", risk: "low", route: "auto_fix", severity: 1,
    base: { ref: "refs/heads/main", sha: "a".repeat(40) }, head, checkpoints: { spend: [], C: {
      by: "human", at: receipt.at, verdict: "approve" } }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 1000, spendMicrousdUsed: 0, spendMicrousdMax: 0, wallclockMaxS: 600 }, mirrors: {},
    landing: { modes: ["auto_land"], target: "refs/heads/main", receipts: [receipt] }, createdAt: receipt.at, updatedAt: receipt.at };
  const files = new Map<string, string>();
  const signals = { get: async () => ({ fingerprint: "observed-fingerprint" }), countSince: async () => 0,
    newFingerprintsInFiles: async () => [], errorRate: async () => ({ errors: 0, requests: 100 }) } as unknown as SignalStore;
  let ctx: FakeContext;
  const journal = { read: async () => ({ head: "journal", trail: (await ctx.trails.get(id))!, events: [] }),
    append: async (_id: string, _head: string, _trail: Trail, _events: TrailEvent[], values: Record<string, string>) => {
      for (const [path, value] of Object.entries(values)) files.set(path, value);
      return "journal";
    },
    readFile: async (_id: string, path: string) => files.has(path) ? new TextEncoder().encode(files.get(path)!) : null,
  } as unknown as Journal;
  ctx = new FakeContext({ id: "repo", url: "https://example.test/repo.git", baseRef: trail.base.ref,
    mirrorDir: ".", forge: "plain", remote: "origin" }, { autonomy: parseAutonomy(AUTONOMY_TEMPLATE), thresholds: {} },
  journal, signals, { now: () => new Date(now) });
  ctx.put(trail);
  const watch: LandingWatch = {
    prepare: t => measureWatchBaseline(ctx, t, ["recorded-probe"]),
    coverage: async () => ({ source: "fixture telemetry query", observedAt: ctx.clock.now().toISOString(), gaps: [] }),
    deployed: async () => ({ sha: head, observedAt: ctx.clock.now().toISOString(), source: "fixture deployment observation" }),
    runProbe: async () => "pass",
  };
  const adapter = { name: "plain-git", prepareLanding: async () => ({}), land: async () => receipt,
    revert: async () => receipt } as unknown as ForgeAdapter;
  const deps: LandingDeps = { adapters: [adapter], watchEveryMs: 1,
    git: async args => args[0] === "show" ? `Ephyra-Trail: ${id}\nEphyra-Proof: ${proof}` : "file.ts", watch };
  return { ctx, trail, files, watch, deps, advance: (ms: number) => { now += ms; } };
}

test("no configured watch or measured baseline means no landing write", async () => {
  const f = fixture();
  let writes = 0;
  f.deps.adapters[0]!.land = async () => { writes++; return receipt; };
  f.deps.watch = undefined;
  const handlers = landingHandlers(f.ctx, f.deps);
  await handlers.land!({ type: "land", key: "land", modes: ["auto_land"] }, f.trail);
  expect(writes).toBe(0);
  expect(f.ctx.emitted[0]).toMatchObject({ type: "parked" });
});

test("measured zero-error baseline is retained, missing request counts never become 1 percent", async () => {
  const f = fixture();
  f.ctx.signals.get = async () => ({ route: "/checkout" }) as never;
  const prepared = await measureWatchBaseline(f.ctx, f.trail, []);
  expect(prepared.baseline.errorRate).toBe(0);
  expect(JSON.parse(prepared.evidence).samples).toEqual([{ route: "/checkout", errors: 0, requests: 100 }]);
  f.ctx.signals.errorRate = async () => null;
  await expect(measureWatchBaseline(f.ctx, f.trail, [])).rejects.toThrow("measured pre-landing");
});

test("measured baseline weights route error counts by actual request volume", async () => {
  const sample = fc.integer({ min: 1, max: 10000 }).chain(requests =>
    fc.integer({ min: 0, max: requests }).map(errors => ({ requests, errors })));
  await fc.assert(fc.asyncProperty(fc.array(sample, { minLength: 1, maxLength: 8 }), async samples => {
    const f = fixture();
    f.trail.signals = samples.map((_, index) => String(index));
    f.ctx.signals.get = async signal => ({ route: `/route/${signal}` }) as never;
    f.ctx.signals.errorRate = async route => samples[Number(route.split("/").at(-1))]!;
    const prepared = await measureWatchBaseline(f.ctx, f.trail, []);
    const expected = samples.reduce((sum, value) => sum + value.errors, 0)
      / samples.reduce((sum, value) => sum + value.requests, 0);
    expect(prepared.baseline.errorRate).toBe(expected);
    expect(prepared.baseline.errorRate).toBeGreaterThanOrEqual(0);
    expect(prepared.baseline.errorRate).toBeLessThanOrEqual(1);
  }));
});

test("watch waits for the exact deployed landing and starts its window at attribution", async () => {
  const f = fixture();
  f.trail.state = "watching";
  f.ctx.put(f.trail);
  const prepared = { ...await f.watch.prepare(f.trail), rev: f.trail.rev, head, base: f.trail.base.sha };
  f.files.set("watch/preparation.json", JSON.stringify(prepared));
  let deployed = false;
  f.watch.deployed = async () => deployed
    ? { sha: head, observedAt: f.ctx.clock.now().toISOString(), source: "deployment" } : null;
  const handlers = landingHandlers(f.ctx, f.deps);
  await handlers.start_watch!({ type: "start_watch", key: "watch" }, f.trail);
  const next = async () => {
    const job = f.ctx.queued.shift()!;
    await f.ctx.jobRunners.get("watch")!(job.payload, { key: job.key, attempt: 1 });
  };
  f.advance(120_000);
  await next();
  expect(f.ctx.emitted).toHaveLength(0);
  expect(JSON.parse(f.files.get("watch/latest.json")!).coverageGaps).toContain("exact deployed revision unavailable");
  deployed = true;
  await next();
  expect(f.ctx.emitted.map(event => event.type)).toEqual(["watch_started"]);
  f.advance(3 * 3600_000);
  await next();
  expect(f.ctx.emitted.at(-1)?.type).toBe("watch_completed");
  expect(JSON.parse(f.files.get("watch/latest.json")!).observations.errorRate).toBeNull();
});

test("missing telemetry and unavailable probes remain journaled gaps, never clean closure", async () => {
  const f = fixture();
  f.trail.state = "watching";
  f.ctx.put(f.trail);
  f.ctx.signals.get = async () => ({ fingerprint: "observed-fingerprint", route: "/checkout" }) as never;
  const prepared = { ...await f.watch.prepare(f.trail), rev: f.trail.rev, head, base: f.trail.base.sha };
  f.files.set("watch/preparation.json", JSON.stringify(prepared));
  f.ctx.signals.errorRate = async () => null;
  f.watch.runProbe = async () => "unavailable";
  const handlers = landingHandlers(f.ctx, f.deps);
  await handlers.start_watch!({ type: "start_watch", key: "watch" }, f.trail);
  const job = f.ctx.queued.shift()!;
  await f.ctx.jobRunners.get("watch")!(job.payload, { key: job.key, attempt: 1 });
  const gaps = JSON.parse(f.files.get("watch/latest.json")!).observations.coverageGaps;
  expect(gaps).toContain("probe:recorded-probe");
  expect(gaps).toContain("error rate:/checkout");
  expect(f.ctx.emitted.some(event => event.type === "watch_completed")).toBe(false);
});

test("rebase schedules a real patch step at the refreshed base and stale effects cannot start work", async () => {
  const f = fixture();
  f.trail.state = "patching";
  f.trail.base.sha = "c".repeat(40);
  f.ctx.put(f.trail);
  const handlers = landingHandlers(f.ctx, f.deps);
  await handlers.rebase!({ type: "rebase", key: "rebase", onto: f.trail.base.sha }, f.trail);
  expect(f.ctx.queued[0]).toMatchObject({ kind: "agent_step", payload: { step: "patch", rev: f.trail.rev } });
  expect((f.ctx.queued[0]!.payload as { note: string }).note).toContain(f.trail.base.sha);
  await handlers.rebase!({ type: "rebase", key: "stale", onto: "a".repeat(40) }, f.trail);
  expect(f.ctx.queued).toHaveLength(1);
});

test("ambiguous forge outcomes remain reconciliation instead of a completed landing effect", async () => {
  const f = fixture();
  const event = { type: "proof_completed", data: { bundle: { rev: 2 }, digest: proof } } as unknown as TrailEvent;
  f.ctx.trails.events = async () => [event];
  f.deps.adapters[0]!.land = async () => { throw new ReconciliationRequired("provider", "unknown"); };
  const handlers = landingHandlers(f.ctx, f.deps);
  await expect(handlers.land!({ type: "land", key: "land", modes: ["auto_land"] }, f.trail)).rejects.toThrow(ReconciliationRequired);
  expect(f.ctx.emitted).toHaveLength(0);
  expect(f.files.has("watch/preparation.json")).toBe(true);
});

test("stale telemetry blocks landing and cannot turn an empty signal store into a clean watch", async () => {
  const f = fixture();
  const event = { type: "proof_completed", data: { bundle: { rev: 2 }, digest: proof } } as unknown as TrailEvent;
  f.ctx.trails.events = async () => [event];
  f.watch.coverage = async () => ({ source: "stale fixture query", observedAt: "2026-11-08T09:00:00.000Z", gaps: [] });
  let writes = 0;
  f.deps.adapters[0]!.land = async () => { writes++; return receipt; };
  const handlers = landingHandlers(f.ctx, f.deps);
  await handlers.land!({ type: "land", key: "land", modes: ["auto_land"] }, f.trail);
  expect(writes).toBe(0);
  expect(f.ctx.emitted[0]?.type).toBe("parked");
  f.trail.state = "watching";
  f.ctx.put(f.trail);
  f.files.set("watch/preparation.json", JSON.stringify({ ...await f.watch.prepare(f.trail), rev: 2, head, base: f.trail.base.sha }));
  await handlers.start_watch!({ type: "start_watch", key: "watch" }, f.trail);
  const job = f.ctx.queued.shift()!;
  await f.ctx.jobRunners.get("watch")!(job.payload, { key: job.key, attempt: 1 });
  expect(JSON.parse(f.files.get("watch/latest.json")!).observations.coverageGaps).toContain("fresh scoped telemetry coverage unavailable");
});

test("high-risk policy approval and critical auto-land cannot bypass named human C", async () => {
  for (const risk of ["high", "critical"] as const) {
    const f = fixture();
    f.trail.risk = risk;
    f.trail.checkpoints.C = { by: "policy", verdict: "approve", at: receipt.at };
    f.ctx.put(f.trail);
    f.ctx.trails.events = async () => [{ type: "proof_completed", data: { bundle: { rev: 2 }, digest: proof } } as unknown as TrailEvent];
    let writes = 0;
    f.deps.adapters[0]!.land = async () => { writes++; return receipt; };
    const handlers = landingHandlers(f.ctx, f.deps);
    await handlers.land!({ type: "land", key: "land", modes: ["auto_land"] }, f.trail);
    expect(writes).toBe(0);
    expect(f.ctx.emitted[0]?.type).toBe("parked");
  }
});
