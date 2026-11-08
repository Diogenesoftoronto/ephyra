import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Trail, TrailEvent, Unverified, budgetBlocker, type AgentResult, type CodingAgent,
  type EvidenceSource, type Runner, type ServiceProfile,
} from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import { MemorySignalStore } from "@ephyra/ingest";
import { LocalRunner } from "@ephyra/runner";
import { parseAutonomy, parseThresholds, THRESHOLDS_TEMPLATE } from "@ephyra/policy";
import { compose, type Composed } from "../compose.ts";
import { readConfig } from "../config.ts";
import { sha256 } from "../docs.ts";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import type { EffectHandlers } from "../orchestrator.ts";
import { MemoryRunStore, RunBroker, RunRecorder } from "../runs.ts";
import { MemoryUsageStore, UsageRecorder } from "../usage.ts";
import { agentHandlers, type AgentDeps } from "./agents.ts";
import { recordTrailUsage } from "./budget.ts";
import { WorkControl } from "./control.ts";
import type { EmitInput, JobRunner, ServerContext } from "./context.ts";
import { humanHandlers } from "./human.ts";
import { Engine } from "./runtime.ts";
import { MemoryStore } from "./store.ts";

const directories: string[] = [];
const applications: Composed[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const at = "2026-11-08T12:00:00.000Z";
const POLICY = "# Policy\n\n## defaults\nmode: enforce\ncheckpoints: A=blocking B=blocking C=blocking\n"
  + "landing: trail_ref\nwatch: 1h\n\n## area: app\npaths: **\nrisk: low\nuser_facing: false\nKeep the application working.\n";
const profile: ServiceProfile = { name: "fixture", digest: "fixture", network: "egress", readOnlyProd: true, credentials: [],
  limits: { cpu: 1, memoryMb: 1000, diskMb: 0, timeoutS: 30 } };

async function sh(cwd: string, argv: string[], input?: string): Promise<string> {
  const process = Bun.spawn(argv, { cwd, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe",
    env: { PATH: globalThis.process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  const [out, error, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new Error(error);
  return out;
}
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-control-integration-"));
  directories.push(directory);
  return directory;
}
function trail(base: string, overrides: Partial<Trail> = {}): Trail {
  return Trail.parse({ schema: 1, id: crypto.randomUUID(), short: "T-fixture", repo: "fixture", title: "Recorded fixture defect",
    rev: 1, state: "researching", workGeneration: 0, signals: [], area: "app", risk: "low", route: "auto_fix", severity: 1,
    base: { ref: "refs/heads/main", sha: base }, checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 10000, wallclockMaxS: 300, spendMicrousdUsed: 0, spendMicrousdMax: 10000 },
    mirrors: {}, createdAt: at, updatedAt: at, ...overrides });
}
function firstEvent(t: Trail) {
  return TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: t.id, rev: t.rev, at,
    actor: { kind: "system", id: "fixture" }, type: "trail_created",
    data: { signalId: crypto.randomUUID(), title: t.title, baseRef: t.base.ref, baseSha: t.base.sha } });
}

async function runtime(overrides: Partial<Trail> = {}, extra: Partial<AgentDeps> = {}) {
  const directory = await temporary();
  await sh(directory, ["git", "init", "--bare", "-q"]);
  const tree = (await sh(directory, ["git", "mktree"], "")).trim();
  const base = (await sh(directory, ["git", "commit-tree", tree], "fixture code\n")).trim();
  await sh(directory, ["git", "update-ref", "refs/heads/main", base]);
  const journal = new GitJournal({ gitDir: directory, clock: { now: () => new Date(at) } });
  let store = new MemoryStore();
  let ledger = new MemoryOperationLedger();
  const jobs = new Map<string, JobRunner>();
  const queue: Array<{ kind: string; key: string; payload: unknown }> = [];
  const signals = new MemorySignalStore();
  let engine: Engine;
  const ctx: ServerContext = {
    repo: { id: "fixture", url: directory, mirrorDir: directory, baseRef: "refs/heads/main", forge: "plain", remote: "origin" },
    policy: { autonomy: parseAutonomy(POLICY), thresholds: parseThresholds(THRESHOLDS_TEMPLATE) }, journal, signals,
    clock: { now: () => new Date(at) }, ids: { uuidv7: () => crypto.randomUUID() }, log: () => {},
    inbox: { put: (item) => store.inboxPut(item), remove: (id) => store.inboxRemove(id),
      get: (id) => store.inboxGet(id), list: () => store.inboxList() },
    jobs: { register: (kind, job) => { jobs.set(kind, job); }, enqueue: async (kind, key, payload) => { queue.push({ kind, key, payload }); } },
    emit: async (input) => { await engine.emit(input); }, start: (t, initial, effects) => engine.start(t, initial, effects),
    trails: { get: (id) => store.getTrail(id), list: (filter) => store.listTrails(filter?.states),
      events: async (id) => (await journal.read(id))?.events ?? [] },
  };
  const control = new WorkControl();
  let allocations = 0, calls = 0, destroyed = 0;
  const files = new Map<string, Uint8Array>();
  const runner: Runner = {
    name: "fixture", capabilities: { shell: true, browser: false, network: ["egress"], checkpoint: "none" },
    async allocate(request) { allocations++; return { id: `fixture-handle-${allocations}`, runner: "fixture", workdir: "/workspace",
      trailId: request.trail.id, attempt: request.attempt, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }; },
    async *exec() { throw new Error("Unexpected fixture command"); },
    async readFile(_handle, path) { return files.get(path) ?? null; },
    async writeFile(_handle, path, bytes) { files.set(path, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes); },
    async checkpoint() { throw new Error("unused"); }, async restore() { throw new Error("unused"); },
    async exportArtifacts() { return []; }, async destroy() { destroyed++; return { destroyed: true, at }; },
  };
  const agent: CodingAgent = { name: "fixture-agent", async run(): Promise<AgentResult> {
    calls++; return { ok: true, artefacts: { "hypothesis.md": `Fixture hypothesis ${calls}.` }, outputs: {}, sessions: [],
      usage: { tokens: 5, costMicrousd: 1, model: "fixture-model" } };
  } };
  const runs = new MemoryRunStore(), usage = new MemoryUsageStore();
  const deps: AgentDeps = { runner, agent, control, profile, stepTimeoutS: 30,
    buildProof: async () => { throw new Unverified("fixture proof unavailable"); },
    usage: new UsageRecorder(usage), runs: new RunRecorder(runs, new RunBroker()), ...extra };
  const handlers = { ...humanHandlers(ctx), ...agentHandlers(ctx, deps) } as EffectHandlers;
  function reconstruct() {
    store = new MemoryStore();
    ledger = new MemoryOperationLedger();
    engine = new Engine(store, journal, ledger, async () => ({ now: at, blocking: { A: true, B: true, C: true },
      landingModes: ["trail_ref"] }), ctx.ids, ctx.log);
    engine.setHandlers(handlers);
  }
  reconstruct();
  const t = trail(base, overrides);
  await ctx.start(t, firstEvent(t));
  const start = (step: "research" | "review", key: string) => handlers.start_agent!({ type: "start_agent", key, step }, t);
  const drainOne = async () => {
    const job = queue.shift();
    if (!job) throw new Error("No fixture job queued");
    await jobs.get(job.kind)!(job.payload, { key: job.key, attempt: 1 });
  };
  return { ctx, t, journal, control, deps, jobs, queue, runs, usage, start, drainOne, reconstruct,
    current: () => ctx.trails.get(t.id), engine: () => engine, counts: () => ({ allocations, calls, destroyed }) };
}

test("durable usage replay after engine reconstruction charges each operation exactly once", async () => {
  const f = await runtime();
  const usage = { tokens: 17, costMicrousd: 23, wallMs: 31 };
  await recordTrailUsage(f.ctx, f.t.id, "observed-call", usage);
  f.reconstruct();
  await recordTrailUsage(f.ctx, f.t.id, "observed-call", usage);
  expect((await f.current())!.budget).toMatchObject({ tokensUsed: 17, spendMicrousdUsed: 23, wallclockUsedMs: 31 });
  expect((await f.journal.read(f.t.id))!.events.filter((event) => event.type === "usage_recorded")).toHaveLength(1);
  await expect(recordTrailUsage(f.ctx, f.t.id, "observed-call", { ...usage, tokens: 18 })).rejects.toThrow("different content");
  expect((await f.current())!.budget.tokensUsed).toBe(17);
});

test("lost bootstrap readiness parks queued research and proof before any runner or agent dispatch", async () => {
  const research = await runtime({}, { canInvestigate: async () => false });
  await research.start("research", "bootstrap-stopped-research");
  await research.drainOne();
  expect(research.counts()).toEqual({ allocations: 0, calls: 0, destroyed: 0 });
  expect((await research.current())!.state).toBe("parked");
  const proof = await runtime({ state: "proving", head: "b".repeat(40) }, { canInvestigate: async () => false });
  await proof.jobs.get("proof")!({ trailId: proof.t.id, rev: proof.t.rev, operationKey: "bootstrap-stopped-proof" },
    { key: "bootstrap-stopped-proof", attempt: 1 });
  expect(proof.counts()).toEqual({ allocations: 0, calls: 0, destroyed: 0 });
  expect((await proof.current())!.state).toBe("parked");
});

test("killing during deferred evidence prevents later allocation and model dispatch", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const source: EvidenceSource = { name: "fixture-evidence", async search() { entered.resolve(); await release.promise; return []; },
    async fetch() { throw new Error("No hits were returned"); } };
  const f = await runtime({}, { evidenceSources: [source] });
  await f.start("research", "initial-research");
  const running = f.drainOne();
  await entered.promise;
  await f.ctx.emit({ trail: f.t.id, actor: { kind: "human", id: "did:example:owner" }, type: "killed", data: { reason: "Stop this investigation" } });
  release.resolve();
  await running;
  expect((await f.current())!.state).toBe("abandoned");
  expect(f.counts()).toEqual({ allocations: 0, calls: 0, destroyed: 0 });
  expect((await f.current())!.budget.unknownTokenEntries ?? 0).toBe(0);
});

test("two same-revision research operations keep separate run transcripts and usage entries", async () => {
  const f = await runtime();
  await f.start("research", "first-research"); await f.drainOne();
  expect((await f.current())!.state).toBe("hypothesised");
  await f.ctx.emit({ trail: f.t.id, actor: { kind: "human", id: "did:example:owner" }, type: "checkpoint_decided",
    data: { checkpoint: "A", decision: { by: "human", who: "did:example:owner", at, verdict: "revise", note: "Inspect another explanation" } } });
  await f.drainOne();
  expect((await f.current())!.rev).toBe(f.t.rev);
  expect(f.counts().calls).toBe(2);
  const recordedRuns = await f.runs.list({ limit: 10 });
  expect(recordedRuns).toHaveLength(2);
  expect(new Set(recordedRuns.map((run) => run.id)).size).toBe(2);
  expect(recordedRuns.every((run) => run.status === "done")).toBe(true);
  const entries = await f.usage.list();
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((entry) => entry.idempotencyKey)).size).toBe(2);
  expect((await f.current())!.budget).toMatchObject({ tokensUsed: 10, spendMicrousdUsed: 2 });
});

test("an old queued job cannot regain ownership after the same revision is parked and resumed", async () => {
  const f = await runtime();
  await f.start("research", "research-before-park");
  const human = { kind: "human" as const, id: "did:example:owner" };
  await f.ctx.emit({ trail: f.t.id, actor: human, type: "parked", data: { reason: "Pause before researching" } });
  await f.ctx.emit({ trail: f.t.id, actor: human, type: "resumed", data: {} });
  expect((await f.current())!.state).toBe(f.t.state);
  expect((await f.current())!.rev).toBe(f.t.rev);
  await f.drainOne();
  expect(f.counts().allocations).toBe(0);
  expect(f.counts().calls).toBe(0);
  await f.drainOne();
  expect(f.counts().calls).toBe(1);
  expect((await f.current())!.state).toBe("hypothesised");
});

test("unknown required review cost stops an owned proof and retains a durable unavailable-cost receipt", async () => {
  const f = await runtime({ state: "handed_off", resumeTo: "proving", head: "b".repeat(40),
    owner: { kind: "human", id: "did:example:owner" }, budget: { tokensUsed: 1, tokensMax: 100, wallclockMaxS: 300,
      spendMicrousdUsed: 0, spendMicrousdMax: 1000, requireKnownCost: true } });
  const ready = Promise.withResolvers<void>();
  let aborted = false;
  const work = f.control.run(f.t.id, f.deps.runner!, async (runner, signal) => {
    const handle = await runner.allocate({ trail: f.t, attempt: 1, repoUrl: "fixture", commit: f.t.base.sha, profile });
    ready.resolve();
    try {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    } finally { await runner.destroy(handle); }
  });
  await ready.promise;
  await recordTrailUsage(f.ctx, f.t.id, "uncertain-owned-review", { tokens: 7, costMicrousd: null, wallMs: 3 });
  await work;
  const current = (await f.current())!;
  expect(current.state).toBe("parked");
  expect(current.owner).toBeUndefined();
  expect(current.budget.unknownCostEntries).toBe(1);
  expect(budgetBlocker(current.budget)).toContain("Spending is unknown");
  expect(aborted).toBe(true);
  expect(f.counts().destroyed).toBe(1);
});

test("an owned proof's definite failure parks once instead of retrying an invalid handed-off transition", async () => {
  const f = await runtime({ state: "handed_off", resumeTo: "proving", head: "b".repeat(40),
    owner: { kind: "human", id: "did:example:owner" } });
  await f.ctx.emit({ trail: f.t.id, actor: { kind: "system", id: "proof" }, type: "agent_failed",
    data: { step: "proof", reason: "Verification integration is unavailable", retryable: false } });
  expect((await f.current())!.state).toBe("parked");
  expect((await f.current())!.owner).toBeUndefined();
  expect(f.queue).toHaveLength(0);
});

test("proof execution time reaches cumulative accounting even when the proof fails", async () => {
  const f = await runtime({ state: "proving", head: "b".repeat(40) }, { buildProof: async () => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    throw new Unverified("fixture proof report unavailable");
  } });
  const current = (await f.journal.read(f.t.id))!;
  const repro = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: f.t.id, rev: f.t.rev, at,
    actor: { kind: "agent", id: "fixture" }, type: "repro_completed", data: { ok: true, probe: ".ephyra/repro/fixture.sh" } });
  await f.journal.append(f.t.id, current.head, current.trail, [repro], { ".ephyra/repro/fixture.sh": "exit 1\n" });
  await f.jobs.get("proof")!({ trailId: f.t.id, rev: f.t.rev, generation: 0, operationKey: "failed-proof" }, { key: "failed-proof", attempt: 1 });
  expect((await f.current())!.budget.wallclockUsedMs).toBeGreaterThanOrEqual(1);
  expect((await f.current())!.state).toBe("parked");
  expect((await f.journal.read(f.t.id))!.events.some((event) => event.type === "usage_recorded" && event.data.wallMs > 0)).toBe(true);
});

async function applicationFixture() {
  const directory = await temporary(), project = join(directory, "project"), data = join(directory, "data");
  await mkdir(join(project, ".ephyra"), { recursive: true }); await mkdir(data);
  await sh(project, ["git", "init", "-q", "-b", "main"]);
  await writeFile(join(project, "value.txt"), "0\n");
  await writeFile(join(project, ".ephyra/config.json"), JSON.stringify({ testCommand: ["node", "--test", "--test-reporter=tap", "test.mjs"] }));
  await writeFile(join(project, "test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict';\n"
    + "import {readFileSync} from 'node:fs'; test('value retains its data format',()=>assert.match(readFileSync('value.txt','utf8'), /^[01]\\n$/));\n");
  await sh(project, ["git", "add", "."]); await sh(project, ["git", "commit", "-qm", "fixture base"]);
  const base = (await sh(project, ["git", "rev-parse", "HEAD"])).trim();
  await writeFile(join(project, "value.txt"), "1\n");
  await sh(project, ["git", "add", "value.txt"]); await sh(project, ["git", "commit", "-qm", "fixture candidate"]);
  const head = (await sh(project, ["git", "rev-parse", "HEAD"])).trim();
  await sh(directory, ["git", "clone", "--mirror", "-q", project, join(data, "workspace.git")]);
  const autonomy = join(directory, "autonomy.md"); await writeFile(autonomy, POLICY);
  let reviews = 0;
  const agent: CodingAgent = { name: "fixture-reviewer", async run() { reviews++; throw new Unverified("unreadable provider usage reply"); } };
  const application = await compose(readConfig({ EPHYRA_API_TOKEN: "fixture-token-1234567890", EPHYRA_DATA_DIR: data,
    EPHYRA_REPO_URL: project, EPHYRA_REPO_ID: "fixture", EPHYRA_AUTONOMY_FILE: autonomy, EPHYRA_REQUIRE_KNOWN_COST: "true",
    EPHYRA_CONSOLE_DIR: join(directory, "no-console") }), { startJobs: false, workspacePrepared: true,
    runner: new LocalRunner(join(directory, "runner"), { trusted: true }), agent, profile });
  application.jobs.stop(); applications.push(application);
  return { application, base, head, reviews: () => reviews };
}

test("the composed reviewer records unknown usage before a rejected provider result can be retried", async () => {
  const f = await applicationFixture();
  const t = trail(f.base, { state: "proving", risk: "medium", head: f.head,
    budget: { tokensUsed: 0, tokensMax: 10000, wallclockMaxS: 300, spendMicrousdUsed: 0,
      spendMicrousdMax: 1000, requireKnownCost: true } });
  const repro = TrailEvent.parse({ schema: 1, id: crypto.randomUUID(), trail: t.id, rev: t.rev, at,
    actor: { kind: "agent", id: "fixture" }, type: "repro_completed", data: { ok: true, probe: ".ephyra/repro/value.sh" } });
  await f.application.ctx.start(t, repro);
  const current = (await f.application.ctx.journal.read(t.id))!;
  await f.application.ctx.journal.append(t.id, current.head, current.trail, [], {
    ".ephyra/repro/value.sh": '#!/bin/sh\ntest "$(cat value.txt)" = 1\n',
  });
  const payload = { trailId: t.id, rev: t.rev, generation: 0, operationKey: "uncertain-review-proof" };
  await f.application.ctx.jobs.enqueue("proof", "uncertain-review-proof", payload);
  await f.application.jobs.drain();
  const parked = (await f.application.ctx.trails.get(t.id))!;
  const failure = await f.application.ctx.journal.readFile(t.id, "proof/error.json");
  expect(f.reviews(), failure ? new TextDecoder().decode(failure) : "No proof error recorded").toBe(1);
  expect(parked.state).toBe("parked");
  expect(parked.budget.unknownTokenEntries).toBe(1);
  expect(parked.budget.unknownCostEntries).toBe(1);
  expect(parked.budget.wallclockUsedMs).toBeGreaterThan(0);
  await f.application.ctx.jobs.enqueue("proof", "late-uncertain-review-proof", payload);
  await f.application.jobs.drain();
  expect(f.reviews()).toBe(1);
});

test("activating a higher risk policy reclassifies the exact diff and rejects the earlier work binding", async () => {
  const f = await applicationFixture();
  const t = trail(f.base, { state: "proving", head: f.head });
  await f.application.ctx.start(t, firstEvent(t));
  const draft = await f.application.drafts.create("autonomy.md", "did:example:owner");
  await f.application.drafts.setContent(draft.id, { baseDigest: draft.baseDigest, content: POLICY.replace("risk: low", "risk: high") });
  const published = await f.application.drafts.publish(draft.id, "did:example:owner");
  const receipt = await f.application.drafts.activate(draft.id, { principal: "did:example:owner", key: "activate-risk-regression",
    expectedCommit: published.published!.commit, expectedDigest: sha256(published.content), expectedActive: null });
  const parked = (await f.application.ctx.trails.get(t.id))!;
  expect(parked.risk).toBe("high");
  expect(parked.area).toBe("app");
  expect(parked.policyCommit).toBe(receipt.commit);
  expect(parked.state).toBe("parked");
  await f.application.ctx.emit({ trail: t.id, actor: { kind: "human", id: "did:example:owner" }, type: "resumed", data: {} });
  const resumed = (await f.application.ctx.trails.get(t.id))!;
  expect(resumed.state).toBe(t.state);
  expect(resumed.rev).toBe(t.rev);
  const old: EmitInput = { trail: t.id, actor: { kind: "system", id: "proof" }, type: "agent_failed",
    data: { step: "proof", reason: "stale outcome", retryable: false }, expectedWork: {
      rev: t.rev, head: t.head, base: t.base.sha, state: t.state, policyCommit: t.policyCommit, generation: t.workGeneration,
    } };
  await expect(f.application.engine.emit(old)).rejects.toThrow("workflow changed");
  expect((await f.application.ctx.trails.get(t.id))!.state).toBe("proving");
});
