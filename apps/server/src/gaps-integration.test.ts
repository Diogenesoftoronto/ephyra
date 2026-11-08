// Offline acceptance through the real composed engine, Git transports, LocalRunner and proof builder.
// Deployment/coverage and persona responses below are explicitly test-only external-service fixtures.
// They establish wiring and refusal behavior, not live hosting, model quality or production repair.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentResult, AgentTask, CodingAgent, Runner, RunnerHandle, Trail } from "@ephyra/core";
import { LocalRunner } from "@ephyra/runner";
import { RemoteGitAdapter } from "@ephyra/forge";
import { type AgentRunOptions } from "@ephyra/agent";
import { compose, type Composed } from "./compose.ts";
import { readConfig } from "./config.ts";
import { measureWatchBaseline } from "./wiring/landing.ts";
import type { GitProbeCatalog, ProbeHandlerDeps } from "./wiring/probes.ts";

const token = "offline-gaps-fixture-token-000000000000";
const headers = { authorization: `Bearer ${token}`, "X-Ephyra-Principal": "offline-fixture-owner", "content-type": "application/json" };
const fixedCart = "exports.total = items => items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;\n";

async function command(cwd: string, args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: "Offline fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Offline fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...identity }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Offline fixture command ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function run(runner: Runner, handle: RunnerHandle, args: string[]): Promise<string> {
  let text = "", exit: number | undefined;
  for await (const part of runner.exec(handle, args, { deadlineMs: 10_000 })) {
    if ("chunk" in part) text += part.chunk;
    else { if (part.timedOut) throw new Error("Offline fixture command timed out"); exit = part.exit; }
  }
  if (exit !== 0) throw new Error(`Offline fixture sandbox command failed: ${text}`);
  return text.trim();
}

/** This local scripted adapter performs no inference: actual model tokens and cost are both zero. */
class ScriptedCodingAgent implements CodingAgent {
  readonly name = "offline-scripted-no-inference";
  readonly steps: string[] = [];
  readonly tasks: AgentTask[] = [];

  async run(task: AgentTask, runner: Runner, handle: RunnerHandle, opts: AgentRunOptions = {}): Promise<AgentResult> {
    this.steps.push(task.step); this.tasks.push(task);
    opts.signal?.throwIfAborted();
    const usage = { tokens: 0, costMicrousd: 0, model: this.name };
    const result = (artefacts: Record<string, string>, outputs: Record<string, string> = {}): AgentResult =>
      ({ ok: true, artefacts, outputs, usage, sessions: [] });
    if (task.step === "research") return result({ "hypothesis.md": "The observed empty-cart error follows division by zero in cart.js." });
    if (task.step === "repro") {
      const probe = ".ephyra/repro/empty-cart.sh";
      const script = "#!/bin/sh\nbun -e 'if(!Number.isFinite(require(\"./cart.js\").total([]))) process.exit(1)'\n";
      await runner.writeFile(handle, probe, script);
      return result({ [probe]: script }, { probe });
    }
    if (task.step === "plan") return result({ "plan.md": "Return zero for an empty cart; preserve nonempty-cart averages." });
    if (task.step === "review") {
      expect(task.untrusted.diff).toContain("items.length ?");
      // The review adapter checks the real candidate checkout before returning its structured fixture verdict.
      await run(runner, handle, ["bun", "scripts/check-intent.ts"]);
      return result({ "review.json": JSON.stringify({ findings: [] }) });
    }
    await runner.writeFile(handle, "cart.js", fixedCart);
    await run(runner, handle, ["git", "add", "cart.js"]);
    await run(runner, handle, ["git", "-c", "user.name=Offline fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-qm", `Fix offline empty-cart fixture\n\nEphyra-Trail: ${task.trail.id}`]);
    return result({}, { head: await run(runner, handle, ["git", "rev-parse", "HEAD"]) });
  }
}

const signal = () => JSON.stringify({ resourceLogs: [{ resource: { attributes: [
  { key: "service.name", value: { stringValue: "offline-shop" } },
] }, scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, severityNumber: 17,
  body: { stringValue: "RangeError: offline empty cart is NaN" }, attributes: [
    { key: "exception.type", value: { stringValue: "RangeError" } },
    { key: "exception.message", value: { stringValue: "offline empty cart is NaN" } },
    { key: "exception.stacktrace", value: { stringValue: "RangeError: offline empty cart is NaN\n    at total (cart.js:1:40)" } },
  ] }] }] }] });

async function fixture(stalePersona = false) {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-gaps-integration-"));
  const source = join(directory, "source"), remote = join(directory, "remote.git"), data = join(directory, "data");
  await mkdir(source); await mkdir(join(source, "scripts")); await mkdir(join(source, "intents"));
  await mkdir(join(source, "fixtures"));
  await command(source, ["git", "init", "-q", "-b", "main"]);
  await writeFile(join(source, "cart.js"), "exports.total = items => items.reduce((a, b) => a + b, 0) / items.length;\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "offline-shop", scripts: { test: "bun test" } }));
  await writeFile(join(source, "cart.test.js"), "const {test,expect}=require('bun:test'); const {total}=require('./cart.js');\n"
    + "test('nonempty cart preserves its average',()=>expect(total([2,4])).toBe(3));\n");
  await writeFile(join(source, "scripts/check-intent.ts"), "const {total}=require('../cart.js');\n"
    + "if(total([])!==0 || total([2,4])!==3) process.exit(1);\nconsole.log('Offline product intent passed');\n");
  await writeFile(join(source, "intents/checkout.md"), "---\nid: checkout\narea: shop\npaths: [cart.js]\nprobes:\n"
    + "  - kind: script\n    id: empty-cart\n    command: [bun, scripts/check-intent.ts]\n    protectedPaths: [scripts/check-intent.ts]\n---\n"
    + "An empty cart has a finite zero total; nonempty-cart averages remain unchanged.\n");
  await writeFile(join(source, "fixtures/traffic.json"), JSON.stringify([{ items: [2, 4], expected: 3 }, { items: [], expected: 0 }]));
  await writeFile(join(source, "scripts/replay.ts"), "import {readFileSync} from 'node:fs'; const {total}=require('../cart.js');\n"
    + "const [trailId,rev,base,head]=process.argv.slice(2);\n"
    + "const observations=JSON.parse(readFileSync('fixtures/traffic.json','utf8')).map((row:any)=>({...row,actual:total(row.items)}));\n"
    + "const failures=observations.filter((row:any)=>row.actual!==row.expected).length;\n"
    + "console.log(JSON.stringify({schema:1,trailId,rev:Number(rev),base,head,items:[{kind:'traffic_replay',\n"
    + "hunter:'offline-recorded-traffic-fixture',diffs:failures,unexplained:failures,report:JSON.stringify(observations)}]}));\n");
  await command(source, ["git", "add", "."]); await command(source, ["git", "commit", "-qm", "Offline product fixture"]);
  const base = await command(source, ["git", "rev-parse", "HEAD"]);
  await command(directory, ["git", "clone", "--bare", "--quiet", source, remote]);
  const policy = join(directory, "autonomy.md");
  await writeFile(policy, "# Offline fixture policy\n\n## defaults\nmode: enforce\n"
    + "checkpoints: A=blocking B=blocking C=blocking\nlanding: auto_land\nwatch: 1m\n\n"
    + "## area: shop\npaths: cart.js\nrisk: medium\nuser_facing: true\nPreserve the explicit checkout intent.\n");
  const agent = new ScriptedCodingAgent();
  let now = Date.now() + 10_000;
  let deployment: "missing" | "exact" = "missing", fresh = true, authorizations = 0;
  let catalog!: GitProbeCatalog;
  let replay!: NonNullable<ProbeHandlerDeps["run"]>;
  const watchQueue: Array<{ key: string; payload: unknown }> = [];
  const server = await compose(readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: data, EPHYRA_REPO_URL: remote,
    EPHYRA_REPO_ID: "offline-shop", EPHYRA_AUTONOMY_FILE: policy, EPHYRA_WATCH_EVERY_S: "1",
    EPHYRA_TRAIL_TOKENS: "1000", EPHYRA_TRAIL_WALLCLOCK_S: "600", EPHYRA_TRAIL_SPEND_MICROUSD: "0" }), {
    startJobs: false, agent, runner: new LocalRunner(join(directory, "runner"), { trusted: true }),
    verification: {
      commands: async context => [{ id: "offline-traffic", command: ["bun", "scripts/replay.ts", context.trail.id,
        String(context.trail.rev), context.base, context.head], kinds: ["traffic_replay"],
        protectedPaths: ["scripts/replay.ts", "fixtures/traffic.json"] }],
      sources: async context => [{ trailId: context.trail.id, rev: context.trail.rev, base: context.base,
        head: stalePersona ? context.base : context.head, operationKey: `offline-persona-fixture:${context.trail.id}:${context.trail.rev}`,
        source: "offline-persona-service-fixture", items: [{ kind: "persona_study", study: "offline-persona-study",
          runId: "offline-synthetic-fixture-run", synthetic: true,
          report: "Test-only synthetic persona receipt. No live model or respondent evidence is claimed." }] }],
    },
    landing: async ({ ctx, ledger, probes, runProbe }) => {
      catalog = probes; replay = runProbe; ctx.clock.now = () => new Date(now);
      const enqueue = ctx.jobs.enqueue.bind(ctx.jobs);
      // A manual scheduling fixture makes each real watch job observable without sleeping through its minute-long window.
      ctx.jobs.enqueue = async (kind, key, payload, opts) => {
        if (kind === "watch") { watchQueue.push({ key, payload }); return; }
        await enqueue(kind, key, payload, opts);
      };
      const adapter = new RemoteGitAdapter(ctx.repo.mirrorDir, { remote, scope: "offline-shop-owner", ledger,
        authorize: async () => { authorizations++; } });
      return { adapters: [adapter], canLand: async () => true, watch: {
        prepare: async trail => measureWatchBaseline(ctx, trail, (await probes.list(trail)).map(probe => probe.id)),
        deployed: async (_trail, receipt) => deployment === "missing" ? null : {
          sha: await adapter.readRemoteRef(receipt.target) ?? "", observedAt: ctx.clock.now().toISOString(),
          source: "offline-deployment-observer-fixture", // Explicit fixture, not an actual deployment attestation.
        },
        coverage: async () => ({ source: "offline-scoped-coverage-fixture", gaps: [],
          observedAt: new Date(now - (fresh ? 0 : 120_000)).toISOString() }),
        runProbe: async (id, trail, operationKey) => {
          const definition = (await probes.list(trail)).find(probe => probe.id === id);
          return definition ? (await runProbe(definition, trail, operationKey)).result : "unavailable";
        },
      } };
    },
  });
  server.jobs.stop(); // Keep all queue execution deterministic and explicit in this offline test.
  const current = async () => (await server.ctx.trails.list())[0]!;
  const pumpWatch = async () => {
    const job = watchQueue.shift();
    if (!job) throw new Error("No offline fixture watch job was scheduled");
    await server.jobs.enqueue("watch", job.key, job.payload, { runAt: new Date(0) });
    await server.jobs.tick();
  };
  return { directory, remote, base, server, agent, catalog, current, pumpWatch,
    replayRegression: async (trail: Trail) => replay((await catalog.list(trail, "regression"))[0]!, trail, "offline-reusable-regression"),
    advance: (ms: number) => { now += ms; }, deploy: () => { deployment = "exact"; },
    freshness: (value: boolean) => { fresh = value; }, authorizations: () => authorizations,
    cleanup: async () => { await server.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function approve(server: Composed, trail: Trail, checkpoint: "A" | "B" | "C") {
  const items = await server.ctx.inbox.list();
  const item = items.find(item => item.trailId === trail.id && item.checkpoint === checkpoint);
  if (!item) throw new Error(`Missing checkpoint ${checkpoint} in offline integration fixture`);
  const response = await server.app.request(`/v1/trails/${trail.id}/decide`, { method: "POST", headers,
    body: JSON.stringify({ checkpoint, verdict: "approve", bound: item.bound }) });
  expect(response.status).toBe(200);
}

async function reachProof(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.server.app.request("/otlp/v1/logs", { method: "POST", headers, body: signal() })).status).toBe(200);
  await f.server.jobs.drain();
  const initial = await f.current(); expect(initial.state).toBe("parked"); expect(initial.risk).toBe("medium");
  // A prerecorded accounting fixture checks that subsequent steps/revisions retain prior usage.
  // The scripted adapter itself reports zero inference tokens/cost, since it makes no model calls.
  await f.server.ctx.emit({ trail: initial.id, actor: { kind: "system", id: "offline-usage-receipt-fixture" },
    type: "usage_recorded", data: { operationKey: "offline-prior-usage-fixture", tokens: 17, costMicrousd: 0, wallMs: 50 } });
  expect((await f.server.app.request(`/v1/trails/${initial.id}/resume`, { method: "POST", headers, body: "{}" })).status).toBe(200);
  await f.server.jobs.drain(); expect((await f.current()).state).toBe("hypothesised");
  await approve(f.server, await f.current(), "A"); await f.server.jobs.drain();
  expect((await f.current()).state).toBe("planned");
  await approve(f.server, await f.current(), "B"); await f.server.jobs.drain();
  return f.current();
}

test("medium user-facing repair proves, conditionally lands remotely and closes only with attributable fresh watch evidence", async () => {
  const f = await fixture();
  try {
    const ready = await reachProof(f);
    expect(ready.state).toBe("ready");
    expect(f.agent.steps).toEqual(["research", "repro", "plan", "patch", "review"]);
    const bytes = await f.server.ctx.journal.readFile(ready.id, "proof/manifest.json");
    const proof = JSON.parse(new TextDecoder().decode(bytes!));
    expect(proof.passed).toBe(true); expect(proof.missing).toEqual([]);
    for (const kind of ["regression_probes", "intent_probes", "bug_review", "persona_study", "traffic_replay"]) {
      expect(proof.items.some((item: { kind: string }) => item.kind === kind)).toBe(true);
    }
    expect(proof.items.find((item: { kind: string }) => item.kind === "regression_probes").ran)
      .toContain(`regression:current:${ready.id}:${ready.rev}`);
    expect(ready.budget.tokensUsed).toBe(17); expect(ready.budget.wallclockUsedMs).toBeGreaterThan(50);
    expect(ready.budget.unknownTokenEntries ?? 0).toBe(0); expect(ready.budget.unknownCostEntries ?? 0).toBe(0);
    expect(await command(f.directory, ["git", "--git-dir", f.remote, "rev-parse", "refs/heads/main"])).toBe(f.base);
    await approve(f.server, ready, "C");
    const watching = await f.current(); expect(watching.state).toBe("watching");
    const receipt = watching.landing!.receipts.at(-1)!;
    expect(receipt.oldOid).toBe(f.base); expect(receipt.newOid).not.toBe(f.base);
    expect(await command(f.directory, ["git", "--git-dir", f.remote, "rev-parse", receipt.target])).toBe(receipt.newOid);
    expect(await command(f.directory, ["git", "--git-dir", f.remote, "show", `${receipt.target}:cart.js`])).toContain("items.length ?");
    expect(f.authorizations()).toBeGreaterThan(1);

    await f.pumpWatch(); expect((await f.current()).state).toBe("watching");
    let latest = JSON.parse(new TextDecoder().decode((await f.server.ctx.journal.readFile(ready.id, "watch/latest.json"))!));
    expect(latest.status).toBe("awaiting_deployment");
    f.deploy(); await f.pumpWatch();
    f.advance(120_000); f.freshness(false); await f.pumpWatch();
    expect((await f.current()).state).toBe("watching");
    latest = JSON.parse(new TextDecoder().decode((await f.server.ctx.journal.readFile(ready.id, "watch/latest.json"))!));
    expect(latest.observations.coverageGaps).toContain("fresh scoped telemetry coverage unavailable");
    f.freshness(true); await f.pumpWatch();
    const closed = await f.current(); expect(closed.state).toBe("closed");
    const registered = await f.catalog.list(closed, "regression");
    expect(registered).toHaveLength(1);
    expect(registered[0]!.source).toMatchObject({ trailId: closed.id, commit: closed.head, proofDigest: receipt.proofDigest });
    expect(await f.replayRegression(closed)).toMatchObject({ id: registered[0]!.id, result: "pass", exit: 0 });
    expect(closed.budget.tokensUsed).toBe(17);
    expect(closed.budget.wallclockUsedMs!).toBeGreaterThan(ready.budget.wallclockUsedMs!);
    expect((await f.server.ctx.trails.events(closed.id)).filter(event => event.type === "usage_recorded").length).toBeGreaterThan(5);
  } finally { await f.cleanup(); }
}, 60_000);

test("a stale external persona fixture parks the proved candidate before approval or any remote write", async () => {
  const f = await fixture(true);
  try {
    const parked = await reachProof(f);
    expect(parked.state).toBe("parked");
    expect(f.agent.steps).toEqual(["research", "repro", "plan", "patch", "review"]);
    expect(parked.checkpoints.C).toBeUndefined();
    expect(await command(f.directory, ["git", "--git-dir", f.remote, "rev-parse", "refs/heads/main"])).toBe(f.base);
    const failure = JSON.parse(new TextDecoder().decode((await f.server.ctx.journal.readFile(parked.id, "proof/error.json"))!));
    expect(failure.reason).toContain("exact revision binding");
    expect(parked.budget.tokensUsed).toBe(17);
    expect(parked.budget.wallclockUsedMs).toBeGreaterThan(50);
  } finally { await f.cleanup(); }
}, 60_000);
