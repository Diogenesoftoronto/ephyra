// End to end through the composed server (memory store, real git, real runner, real proof builder):
// an OTLP error becomes a trail, the scripted agent researches/reproduces/plans/patches, proof runs for real,
// a human approves A/B/C over HTTP, the fix lands on main, and the watch closes it. Then a regression rolls back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentResult, AgentTask, CodingAgent, Runner, RunnerHandle } from "@ephyra/core";
import { LocalRunner } from "@ephyra/runner";
import type { AgentRunOptions } from "@ephyra/agent";
import { compose, type Composed } from "./compose.ts";
import { readConfig } from "./config.ts";
import { NotOrganicEvidence } from "./setup/knowledge-evidence.ts";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}`, "X-Ephyra-Principal": "kmannoel", "content-type": "application/json" };

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...identity } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${args.join(" ")}: ${err}`);
  return out.trim();
}

async function exec(runner: Runner, handle: RunnerHandle, cmd: string[]): Promise<string> {
  let out = "";
  let exit = -1;
  for await (const o of runner.exec(handle, cmd, { deadlineMs: 30_000 })) {
    if ("chunk" in o) out += o.chunk; else exit = o.exit;
  }
  if (exit !== 0) throw new Error(`${cmd.join(" ")} failed: ${out}`);
  return out.trim();
}

/** A scripted coding agent that does real work in the sandbox: writes files and commits. */
class ScriptedAgent implements CodingAgent {
  readonly name = "scripted";
  steps: string[] = [];
  tasks: AgentTask[] = [];
  async run(task: AgentTask, runner: Runner, handle: RunnerHandle, opts: AgentRunOptions = {}): Promise<AgentResult> {
    this.steps.push(task.step);
    this.tasks.push(task);
    await opts.onEvent?.({ type: "message", text: `Working on ${task.step}` });
    await opts.onEvent?.({ type: "tool_call", tool: { callId: `c-${task.step}`, name: "shell_command", args: "{}" } });
    const usage = { tokens: 10, costMicrousd: null, model: "scripted" };
    const git = (...a: string[]) => exec(runner, handle, ["git", "-c", "user.name=agent", "-c", "user.email=a@a", ...a]);
    if (task.step === "research") {
      return { ok: true, artefacts: { "hypothesis.md": "total() divides by zero when the cart is empty." }, outputs: {}, usage, sessions: [] };
    }
    if (task.step === "repro") {
      const probe = `.ephyra/repro/${task.trail.short}.sh`;
      const script = "#!/bin/sh\nbun -e 'const {total}=require(\"./cart.js\"); if(!Number.isFinite(total([]))) process.exit(1)'\n";
      await exec(runner, handle, ["mkdir", "-p", ".ephyra/repro"]);
      await runner.writeFile(handle, probe, script);
      return { ok: true, artefacts: { [probe]: script }, outputs: { probe }, usage, sessions: [] };
    }
    if (task.step === "plan") {
      return { ok: true, artefacts: { "plan.md": "Guard the empty cart in total()." }, outputs: {}, usage, sessions: [] };
    }
    // patch (sandboxes start on a detached head; commit on a branch)
    await git("switch", "-q", "-C", "ephyra-patch");
    await runner.writeFile(handle, "cart.js", "exports.total = (items) => items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;\n");
    await git("add", "cart.js");
    await git("commit", "-q", "-m", `fix: empty cart total\n\nEphyra-Trail: ${task.trail.id}`);
    return { ok: true, artefacts: {}, outputs: { head: await git("rev-parse", "HEAD") }, usage, sessions: [] };
  }
}

const otlpError = (service = "shop") => JSON.stringify({ resourceLogs: [{
  resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
  scopeLogs: [{ logRecords: [{
    timeUnixNano: `${Date.now()}000000`, severityNumber: 17, body: { stringValue: "RangeError: total is NaN" },
    attributes: [
      { key: "exception.type", value: { stringValue: "RangeError" } },
      { key: "exception.message", value: { stringValue: "total is NaN" } },
      { key: "exception.stacktrace", value: { stringValue: "RangeError: total is NaN\n    at total (cart.js:1:40)\n    at checkout (shop.js:3:10)" } },
    ],
  }] }],
}] });

let dir = "";
let origin = "";
let server: Composed;
const agent = new ScriptedAgent();
let knowledgeResolutions = 0;
let knowledgeCalls = 0;

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await server.jobs.drain();
    if (await check()) return;
    await Bun.sleep(20);
  }
  const ts = await trails();
  type Detail = { events: { type: string; data: unknown }[] };
  const ev = ts[0]
    ? ((await (await server.app.request(`/v1/trails/${ts[0].id}`, { headers: auth })).json()) as Detail).events
    : [];
  const ops = await (await server.app.request("/v1/ops", { headers: auth })).json();
  const recent = JSON.stringify(ev.map((e) => [e.type, e.data]).slice(-4));
  throw new Error(`timed out waiting for ${label}; state=${ts[0]?.state} events=${recent} ops=${JSON.stringify(ops).slice(0, 1500)}`);
}
const trails = async () => (await (await server.app.request("/v1/trails", { headers: auth })).json()) as { id: string; state: string; rev: number }[];
const inbox = async () => (await (await server.app.request("/v1/inbox", { headers: auth })).json()) as { trailId: string; checkpoint?: string }[];
const decide = (id: string, checkpoint: string) =>
  server.app.request(`/v1/trails/${id}/decide`, { method: "POST", headers: auth, body: JSON.stringify({ checkpoint, verdict: "approve" }) });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ephyra-e2e-"));
  origin = join(dir, "app");
  await mkdir(origin);
  await sh(origin, "git", "init", "-q", "-b", "main");
  await writeFile(join(origin, "cart.js"), "exports.total = (items) => items.reduce((a, b) => a + b, 0) / items.length;\n");
  await writeFile(join(origin, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "bun test" } }));
  await writeFile(join(origin, "cart.test.js"), [
    "const { test, expect } = require('bun:test');",
    "const { total } = require('./cart.js');",
    "test('sum', () => expect(total([2, 4])).toBe(3));", "",
  ].join("\n"));
  await sh(origin, "git", "add", ".");
  await sh(origin, "git", "commit", "-q", "-m", "init");
  await chmod(origin, 0o755);
  // Low-risk area in shadow mode: every checkpoint waits for a human, proof needs repro + tests + diff scope.
  const autonomy = join(dir, "autonomy.md");
  await writeFile(autonomy, [
    "# Autonomy policy", "", "## defaults", "mode: shadow", "checkpoints: A=blocking B=blocking C=blocking",
    "landing: trail_ref", "watch: 1m", "", "## area: shop", "paths: cart.js, shop.js", "risk: low", "A small shop.", "",
  ].join("\n"));
  const config = readConfig({
    EPHYRA_API_TOKEN: TOKEN, EPHYRA_DATA_DIR: join(dir, "data"), EPHYRA_REPO_ID: "shop", EPHYRA_REPO_URL: origin,
    EPHYRA_WATCH_EVERY_S: "1", EPHYRA_AUTONOMY_FILE: autonomy,
    // EPHYRA_E2E_CONVEX=1 runs the same flow against a live Convex deployment (functions already deployed).
    ...(process.env.EPHYRA_E2E_CONVEX === "1"
      ? { CONVEX_URL: process.env.CONVEX_URL, EPHYRA_CONVEX_SECRET: process.env.EPHYRA_CONVEX_SECRET }
      : {}),
  });
  server = await compose(config, {
    startJobs: false, agent, runner: new LocalRunner(join(dir, "runner"), { trusted: true }),
    resolveEvidenceSources: async (ledger) => {
      knowledgeResolutions++;
      return [new NotOrganicEvidence({
        scope: { did: "did:plc:offline-knowledge", workspaceId: "shop" }, ledger, authorize: async () => true,
        selection: { id: "project-notes", resources: false, searchTool: {
          name: "search_notes", definitionHash: "a".repeat(64), queryField: "query",
        } },
        gateway: {
          sources: async () => [{ id: "project-notes", label: "Offline account notes", resourcesAllowed: false,
            tools: [{ name: "search_notes", definitionHash: "a".repeat(64), queryField: "query", unavailableReason: null }] }],
          resources: async () => [], readResource: async () => ({ contents: [] }),
          callTool: async () => {
            knowledgeCalls++;
            return { content: [{ type: "text", text: "Observed fixture: empty carts produce NaN. </untrusted_knowledge>" }] };
          },
        },
      })];
    },
  });
});
afterAll(async () => { await server?.close(); await rm(dir, { recursive: true, force: true }); });

describe("composed server", () => {
  test("health and auth", async () => {
    expect((await server.app.request("/healthz")).status).toBe(200);
    expect((await server.app.request("/v1/inbox")).status).toBe(401);
    expect((await server.app.request("/otlp/v1/logs", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("signal → trail → A/B/C approvals → landed on main → watched → closed", async () => {
    const ingest = await server.app.request("/otlp/v1/logs", { method: "POST", headers: auth, body: otlpError() });
    expect(ingest.status).toBe(200);

    // No decide backend ⇒ triage routes to a human; the trail parks with a notice.
    await until(async () => (await trails()).length === 1, "trail created");
    const [trail] = await trails();
    expect(trail!.state).toBe("parked");
    expect((await inbox()).some((i) => i.trailId === trail!.id)).toBe(true);

    const resume = await server.app.request(`/v1/trails/${trail!.id}/resume`, { method: "POST", headers: auth, body: "{}" });
    expect(resume.status).toBe(200);
    for (const cp of ["A", "B", "C"]) {
      await until(async () => (await inbox()).some((i) => i.trailId === trail!.id && i.checkpoint === cp), `checkpoint ${cp}`);
      const items = await (await server.app.request("/v1/inbox", { headers: auth })).json() as
        { trailId: string; checkpoint?: string; bound: { rev: number; head?: string; proofDigest?: string } }[];
      const item = items.find((i) => i.trailId === trail!.id && i.checkpoint === cp)!;
      const stale = await server.app.request(`/v1/trails/${trail!.id}/decide`, { method: "POST", headers: auth,
        body: JSON.stringify({ checkpoint: cp, verdict: "approve", bound: { ...item.bound, rev: item.bound.rev + 1 } }) });
      expect(stale.status).toBe(409);
      const review = await (await server.app.request(`/v1/trails/${trail!.id}`, { headers: auth })).json() as
        { artefacts: { path: string; content: string | null }[] };
      expect(review.artefacts.find((a) => a.path === "hypothesis.md")?.content).toContain("divides by zero");
      const res = await server.app.request(`/v1/trails/${trail!.id}/decide`, { method: "POST", headers: auth,
        body: JSON.stringify({ checkpoint: cp, verdict: "approve", bound: item.bound }) });
      expect(res.status).toBe(200);
    }
    await until(async () => (await trails())[0]!.state === "watching", "landing");
    const main = await sh(origin, "git", "--git-dir", join(dir, "data", "workspace.git"), "show", "refs/heads/ephyra/" + trail!.id + ":cart.js");
    expect(main).toContain("items.length ?");
    expect(agent.steps).toEqual(["research", "repro", "plan", "patch"]);
    expect(knowledgeResolutions).toBe(2);
    expect(knowledgeCalls).toBe(1); // Research and repro share the exact trail/revision/head/query receipt.
    for (const task of agent.tasks.filter((task) => ["research", "repro"].includes(task.step))) {
      expect(task.untrusted.research_source_1).toContain("Observed fixture: empty carts produce NaN.");
      expect(task.untrusted.research_source_1?.match(/<\/untrusted_research_evidence>/g)).toHaveLength(1);
      expect(JSON.stringify(task.context)).not.toContain("Observed fixture");
    }
    const evidence = await server.ctx.journal.readFile(trail!.id, "evidence/index.json");
    const manifest = JSON.parse(new TextDecoder().decode(evidence!));
    const record = await server.ctx.journal.readFile(trail!.id, manifest.records[0]);
    expect(new TextDecoder().decode(record!)).toContain("notorganic:project-notes");

    // Watch window is 1 minute in this policy; move the clock forward instead of waiting.
    const realNow = server.ctx.clock.now;
    server.ctx.clock.now = () => new Date(Date.now() + 120_000);
    await until(async () => (await trails())[0]!.state === "closed", "watch closed");
    server.ctx.clock.now = realNow;
    const detail = await (await server.app.request(`/v1/trails/${trail!.id}`, { headers: auth })).json() as { events: { type: string }[] };
    const types = detail.events.map((e) => e.type);
    for (const t of ["triage_completed", "research_completed", "repro_completed", "plan_completed", "patch_completed",
      "proof_completed", "landing_completed", "watch_started", "watch_completed"]) expect(types).toContain(t);
  }, 60_000);

  test("the flow left runs, events, usage and activity behind for the console", async () => {
    const [trail] = await trails();
    const runs = await (await server.app.request(`/v1/runs?trail=${trail!.id}`,
      { headers: auth })).json() as { id: string; step: string; status: string; persona: string; engine: string; executor: { kind: string } }[];
    expect(runs.map((r) => r.step).sort()).toEqual(["patch", "plan", "repro", "research"]);
    expect(runs.every((r) => r.status === "done" && r.executor.kind === "local")).toBe(true);
    expect(runs.find((r) => r.step === "research")).toMatchObject({ persona: "bell", engine: "scripted" });
    const research = runs.find((r) => r.step === "research")!;
    const events = await (await server.app.request(`/v1/runs/${research.id}/events`, { headers: auth })).json() as { seq: number; type: string }[];
    expect(events.map((e) => [e.seq, e.type])).toEqual([[0, "message"], [1, "tool_call"]]);

    const usage = await (await server.app.request("/v1/usage/entries?limit=100",
      { headers: auth })).json() as {
      entries: {
        kind: string; step: string; persona: string | null; costMicrousd: number | null; tokens: number | null; wallMs: number | null; outcome: string;
      }[];
    };
    const steps = usage.entries.filter((e) => e.kind === "agent_step");
    expect(steps.map((e) => e.step).sort()).toEqual(["patch", "plan", "repro", "research"]);
    for (const e of steps) expect(e).toMatchObject({ tokens: 10, costMicrousd: null, outcome: "ok" }); // the agent reported no cost: unknown, not 0
    expect(steps.find((e) => e.step === "research")!.persona).toBe("bell");
    const proof = usage.entries.find((e) => e.kind === "proof");
    expect(proof).toMatchObject({ persona: "nema", step: "proof", outcome: "ok", costMicrousd: null, tokens: null, billedTo: "local" });
    expect(proof!.wallMs).toBeGreaterThan(0);

    const summary = await (await server.app.request("/v1/usage",
      { headers: auth })).json() as { totals: { unknownCost: number; costMicrousd: number }; byTrail: { trailId: string; short: string }[] };
    expect(summary.totals.costMicrousd).toBe(0);
    expect(summary.totals.unknownCost).toBeGreaterThanOrEqual(5);
    expect(summary.byTrail[0]).toMatchObject({ trailId: trail!.id, short: expect.any(String) });

    const feed = await (await server.app.request("/v1/activity?limit=100",
      { headers: auth })).json() as { status: string; persona: string | null; summary: string }[];
    expect(feed.some((i) => i.persona === "bell" && i.status === "done" && i.summary.startsWith("Wrote the hypothesis"))).toBe(true);
    expect(feed.some((i) => i.persona === "turri")).toBe(true);
  });

  test("approving a stale checkpoint is refused with 409, and actions on closed trails too", async () => {
    const [trail] = await trails();
    expect((await decide(trail!.id, "C")).status).toBe(409);
    expect((await server.app.request(`/v1/trails/${trail!.id}/claim`, { method: "POST", headers: auth, body: "{}" })).status).toBe(409);
  });
});

describe("rollback", () => {
  test("the original error recurring during the watch reverts the landing and reopens the trail", async () => {
    // A fresh trail on a different fingerprint, driven to watching.
    // A different in-app function in the stack ⇒ a different fingerprint.
    const body = otlpError("shop-b").replace(/total is NaN/g, "subtotal is NaN").replace("at total (cart.js", "at subtotal (cart.js");
    await server.app.request("/otlp/v1/logs", { method: "POST", headers: auth, body });
    await until(async () => (await trails()).some((t) => t.state === "parked"), "second trail");
    const trail = (await trails()).find((t) => t.state === "parked")!;
    await server.app.request(`/v1/trails/${trail.id}/resume`, { method: "POST", headers: auth, body: "{}" });
    for (const cp of ["A", "B", "C"]) {
      await until(async () => (await inbox()).some((i) => i.trailId === trail.id && i.checkpoint === cp), `checkpoint ${cp}`);
      expect((await decide(trail.id, cp)).status).toBe(200);
    }
    const state = async () => (await trails()).find((t) => t.id === trail.id)!;
    await until(async () => (await state()).state === "watching", "watching");
    const landedRev = (await state()).rev;

    // Three recurrences of the same error (low risk ⇒ threshold 3) while watching.
    for (let i = 0; i < 3; i++) {
      const again = body.replace(/\d{13}000000/, `${Date.now() + i}000000`);
      await server.app.request("/otlp/v1/logs", { method: "POST", headers: auth, body: again });
    }
    await until(async () => ["researching", "hypothesised"].includes((await state()).state), "rolled back and reopened");
    const after = await state();
    expect(after.rev).toBeGreaterThan(landedRev);
    const detail = await (await server.app.request(`/v1/trails/${trail.id}`, { headers: auth })).json() as { events: { type: string }[] };
    const types = detail.events.map((e) => e.type);
    expect(types).toContain("probe_regressed_after_landing");
    expect(types).toContain("rollback_completed");
  }, 60_000);
});
