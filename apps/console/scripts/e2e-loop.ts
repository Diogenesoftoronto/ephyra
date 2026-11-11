/**
 * End to end: does Ephyra drive, and does the console show it?
 *
 *   env -u LD_LIBRARY_PATH bun --no-env-file scripts/e2e-loop.ts                 every act, server and browser
 *   env -u LD_LIBRARY_PATH bun --no-env-file scripts/e2e-loop.ts --server-only   the loop over HTTP, no browser
 *   ... --no-build   reuse apps/console/dist        ... --keep   leave the temp repository on disk
 *
 * What is real: the server (`compose()`), the HTTP routes, git, the journal, the local runner, the proof builder (it runs
 * the fixture repository's own tests), the policy file, landing on a trail ref, the watch loop, the built console, a browser.
 * What is scripted, and labelled as such wherever it is recorded: the coding agent (`scripted/e2e`), the decide backend
 * (`fixture/e2e-decide-1`) and the production telemetry behind the watch ("offline fixture"). No network is used.
 *
 * The run exits 0 only when every act passes. A check that could not be exercised counts as a failure: this script is the
 * definition of "it works end to end", so nothing in it is allowed to pass by being skipped.
 */
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import type {
  AgentResult, AgentTask, CodingAgent, DecideBackend, InvestigationQuestion, JudgementAnswer, JudgementRequest, JudgementResponse, Runner,
  RunnerHandle, Trail, TrailEvent,
} from "@ephyra/core";
import type { AgentRunOptions } from "../../../packages/agent/src/index.ts";
import { PlainGitAdapter } from "../../../packages/forge/src/index.ts";
import { LocalRunner } from "../../../packages/runner/src/index.ts";
import { compose, type Composed } from "../../server/src/compose.ts";
import { readConfig } from "../../server/src/config.ts";
import { measureWatchBaseline } from "../../server/src/wiring/landing.ts";
import {
  fleetView, journeyOf, parseRecovery, questView, type InboxLike, type QuestView, type RecoveryArtifact,
} from "../src/loop/model.ts";
import { launch } from "./browser.ts";
import { CRITERIA, runAcceptance } from "./loop-acceptance.ts";

const args = process.argv.slice(2);
const root = join(import.meta.dir, "..");
const TOKEN = "e2e-loop-offline-service-token";
const PRINCIPAL = "e2e-operator";
const DECIDE_MODEL = "fixture/e2e-decide-1";
const headers = { Authorization: `Bearer ${TOKEN}`, "X-Ephyra-Principal": PRINCIPAL, "content-type": "application/json" };

// ───────────────────────── The scripted parts ─────────────────────────

async function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@localhost", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@localhost" };
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...identity } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err}`);
  return out.trim();
}

async function exec(runner: Runner, handle: RunnerHandle, cmd: string[]): Promise<string> {
  let out = "";
  let exit = -1;
  for await (const part of runner.exec(handle, cmd, { deadlineMs: 30_000 })) {
    if ("chunk" in part) out += part.chunk; else exit = part.exit;
  }
  if (exit !== 0) throw new Error(`${cmd.join(" ")} failed: ${out}`);
  return out.trim();
}

type Script = {
  file: string; hypothesis: string; plan: string; probe: string; patches: readonly string[];
  /** A step whose first attempt gives up, so the server has to plan a second one. */
  stumbles?: "research";
};
/**
 * What the scripted agent knows about each area of the fixture repository. Where there are two patches the first is wrong
 * on purpose: it satisfies the probe and breaks a test that already passed, which is what the proof is there to catch.
 */
const SCRIPT: Record<string, Script> = {
  shop: {
    file: "cart.js", hypothesis: "total() divides by zero when the cart is empty.", plan: "Guard the empty cart in total().",
    probe: "const {total}=require(\"./cart.js\"); if(!Number.isFinite(total([]))) process.exit(1)",
    patches: ["exports.total = (items) => items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;\n"],
  },
  payments: {
    file: "pay.js", hypothesis: "split() divides cents with floating point, so the parts are not whole cents.",
    plan: "Split in whole cents and hand the remainder out one cent at a time.", stumbles: "research",
    probe: "const {split}=require(\"./pay.js\"); const p=split(100,3); if(p.some(x=>!Number.isInteger(x))||p.reduce((a,b)=>a+b,0)!==100) process.exit(1)",
    patches: [
      // Whole cents, remainder on the first part. With nobody to split with it invents a part: [NaN] instead of [].
      "exports.split = (cents, n) => { const parts = Array(n).fill(Math.floor(cents / n)); parts[0] += cents - parts[0] * n; return parts; };\n",
      "exports.split = (cents, n) => Array.from({ length: n }, (_, i) => Math.floor(cents / n) + (i < cents % n ? 1 : 0));\n",
    ],
  },
  search: {
    file: "search.js", hypothesis: "find() calls includes() on a null item.", plan: "Skip items that are not strings.",
    probe: "const {find}=require(\"./search.js\"); try { find([\"apple\", null], \"a\") } catch { process.exit(1) }",
    patches: [
      // Stops the crash by lower-casing everything, which quietly makes a case-sensitive search case-insensitive.
      "exports.find = (items, q) => items.filter((item) => String(item).toLowerCase().includes(q));\n",
      "exports.find = (items, q) => items.filter((item) => typeof item === \"string\" && item.includes(q));\n",
    ],
  },
};

type Hold = { reached: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void };

class ScriptedAgent implements CodingAgent {
  readonly name = "scripted/e2e";
  /** Every turn it was given, as `<area>:<step>:<nth turn of that step>`, with the recovery instruction the server sent. */
  readonly turns: { key: string; recovery: string }[] = [];
  private readonly counts = new Map<string, number>();
  private readonly holds = new Map<string, Hold>();
  /** Makes one turn wait until `release`, so a browser can look at a quest in the middle of its work. */
  hold(key: string): Hold {
    let arrive = () => {};
    let release = () => {};
    const hold = { reached: new Promise<void>((done) => { arrive = done; }), released: new Promise<void>((done) => { release = done; }), arrive, release };
    this.holds.set(key, hold);
    return hold;
  }
  releaseAll(): void { for (const hold of this.holds.values()) hold.release(); }
  async run(task: AgentTask, runner: Runner, handle: RunnerHandle, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const area = task.trail.area ?? "";
    const script = SCRIPT[area];
    if (!script) throw new Error(`the scripted agent has no script for area "${area}"`);
    const count = `${task.trail.id}:${task.step}`;
    const n = (this.counts.get(count) ?? 0) + 1;
    this.counts.set(count, n);
    const key = `${area}:${task.step}:${n}`;
    this.turns.push({ key, recovery: String((task.context as Record<string, unknown>).recovery ?? "") });
    await opts.onEvent?.({ type: "message", text: `Scripted agent, no model: ${task.step} in ${area}, turn ${n}.` });
    const hold = this.holds.get(key);
    if (hold) { hold.arrive(); await hold.released; }
    const usage = { tokens: 10, costMicrousd: null, model: "scripted/e2e" };
    if (script.stumbles === task.step && n === 1) {
      // A turn that dies without saying what it used parks the quest ("Token usage is unknown"), so say it first.
      await opts.onUsage?.({ key: `scripted:${task.trail.id}:${task.step}:${n}`, ...usage });
      throw new Error("scripted failure: the first reading went nowhere, by design of this test");
    }
    const git = (...a: string[]) => exec(runner, handle, ["git", "-c", "user.name=agent", "-c", "user.email=agent@localhost", ...a]);
    if (task.step === "research") return { ok: true, artefacts: { "hypothesis.md": script.hypothesis }, outputs: {}, usage, sessions: [] };
    if (task.step === "plan") return { ok: true, artefacts: { "plan.md": script.plan }, outputs: {}, usage, sessions: [] };
    if (task.step === "repro") {
      const probe = `.ephyra/repro/${task.trail.short}.sh`;
      const body = `#!/bin/sh\nbun -e '${script.probe}'\n`;
      await exec(runner, handle, ["mkdir", "-p", ".ephyra/repro"]);
      await runner.writeFile(handle, probe, body);
      return { ok: true, artefacts: { [probe]: body }, outputs: { probe }, usage, sessions: [] };
    }
    if (task.step !== "patch") throw new Error(`the scripted agent has no script for step "${task.step}"`);
    await git("switch", "-q", "-C", "ephyra-patch");
    await runner.writeFile(handle, script.file, script.patches[Math.min(n, script.patches.length) - 1]!);
    await git("add", script.file);
    await git("commit", "-q", "-m", `fix(${area}): attempt ${n}\n\nEphyra-Trail: ${task.trail.id}`);
    return { ok: true, artefacts: {}, outputs: { head: await git("rev-parse", "HEAD") }, usage, sessions: [] };
  }
}

/** A decide backend that always answers "yes, ours, fix it", under its own identity so nothing mistakes it for a model. */
const fixtureDecide: DecideBackend = {
  kind: "selfhosted:fixture", alias: "e2e-decide", supports: ["noul", "choice", "score"],
  async decide(request: JudgementRequest): Promise<JudgementResponse> {
    const answers: Record<string, JudgementAnswer> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "noul") answers[key] = { type: "noul", noul: 0.95 };
      else if (question.type === "score") answers[key] = { type: "score", score: 1, probabilities: { "1": 0.95 }, legend: {}, confidence: 0.95 };
      else {
        const offered = Object.keys(question.criteria);
        const choice = offered.includes("auto_fix") ? "auto_fix" : offered.includes("none") ? "none" : offered[0] ?? "none";
        answers[key] = { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 };
      }
    }
    return { model: DECIDE_MODEL, answers };
  },
};

const otlpError = (service: string, type: string, message: string, stack: string) => JSON.stringify({ resourceLogs: [{
  resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
  scopeLogs: [{ logRecords: [{
    timeUnixNano: `${Date.now()}000000`, severityNumber: 17, body: { stringValue: `${type}: ${message}` },
    attributes: [
      { key: "exception.type", value: { stringValue: type } },
      { key: "exception.message", value: { stringValue: message } },
      { key: "exception.stacktrace", value: { stringValue: `${type}: ${message}\n${stack}` } },
    ],
  }] }],
}] });

// ───────────────────────── The run ─────────────────────────

type Status = "pass" | "fail" | "skip" | "not reached";
const results: { id: string; promise: string; status: Status; detail: string }[] = [];
let broken: string | null = null;

/** `gate: false` lets the run go on after a failure. `always` runs the act even after an earlier one stopped the run. */
async function act(id: string, promise: string, run: () => Promise<string>, { gate = true, always = false } = {}): Promise<boolean> {
  if (broken && !always) { results.push({ id, promise, status: "not reached", detail: `stopped at "${broken}"` }); return false; }
  try {
    results.push({ id, promise, status: "pass", detail: await run() });
    return true;
  } catch (error) {
    results.push({ id, promise, status: "fail", detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
    if (gate) broken = broken ?? id;
    return false;
  }
}
const must = (ok: unknown, why: string): void => { if (!ok) throw new Error(why); };

const dir = await mkdtemp(join(tmpdir(), "ephyra-e2e-loop-"));
const origin = join(dir, "app");
let server: Composed | null = null;
let http: ReturnType<typeof Bun.serve> | null = null;
let base = "";
let pumping = true;
let pumpError: unknown = null;

type Detail = { trail: Trail; events: TrailEvent[]; artefacts: { path: string; content: string | null }[] };
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return await response.json() as T;
};
const trails = () => get<Trail[]>("/v1/trails");
const detail = (id: string) => get<Detail>(`/v1/trails/${id}`);
const inbox = () => get<(InboxLike & { bound?: unknown })[]>("/v1/inbox");

async function until(check: () => Promise<boolean>, label: string, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pumpError) throw new Error(`the job loop failed while waiting for ${label}: ${String(pumpError)}`);
    if (await check()) return;
    await Bun.sleep(60);
  }
  const all = await trails();
  const seen = await Promise.all(all.map(async (trail) => {
    const { events } = await detail(trail.id);
    const last = events.at(-1);
    return `${trail.short} ${trail.state}: ${events.slice(-3).map((event) => event.type).join(" → ")} ${JSON.stringify(last?.data ?? {}).slice(0, 400)}`;
  }));
  throw new Error(`timed out waiting for ${label}. ${seen.join("; ") || "no quests"}`);
}

/**
 * The recovery plans the server kept for a quest. Trail detail does not list them, so a reader has to guess each path
 * (`artefacts/recovery/<step>-<rev>-<attempt>.json`) and ask for it. That is a gap: see design/09-console-redesign.md §8.
 */
async function recoveryOf(trail: Trail): Promise<RecoveryArtifact[]> {
  const paths: string[] = [];
  for (const step of ["research", "repro", "plan", "patch"]) {
    for (let rev = 0; rev <= trail.rev; rev++) for (let n = 1; n <= 4; n++) paths.push(`artefacts/recovery/${step}-${rev}-${n}.json`);
  }
  const files = await Promise.all(paths.map(async (path) => {
    const response = await fetch(`${base}/v1/trails/${trail.id}/file?path=${encodeURIComponent(path)}`, { headers });
    return { path, content: response.ok ? await response.text() : null };
  }));
  return parseRecovery(files);
}

/** Open questions, or none on a server that cannot ask anyone (it answers 404). */
async function questions(): Promise<InvestigationQuestion[]> {
  const response = await fetch(`${base}/v1/questions`, { headers });
  return response.ok ? await response.json() as InvestigationQuestion[] : [];
}

/** What the console should be showing for one quest, computed from what the server holds. */
async function expected(trail: Trail): Promise<QuestView> {
  const [{ events }, items, recovery, asked] = await Promise.all([detail(trail.id), inbox(), recoveryOf(trail), questions()]);
  return questView({ trail, events, inbox: items, recovery, questions: asked, viewer: PRINCIPAL });
}
const sentenceNow = async () => fleetView(await Promise.all((await trails()).map(expected))).sentence;
const current = async (id: string) => (await trails()).find((trail) => trail.id === id)!;
const signal = async (type: string, message: string, stack: string) => {
  const sent = await fetch(`${base}/otlp/v1/logs`, { method: "POST", headers, body: otlpError("shop", type, message, stack) });
  must(sent.ok, `the signal was refused: ${sent.status}`);
};

async function fixtureRepository(): Promise<string> {
  await mkdir(origin);
  await sh(origin, "git", "init", "-q", "-b", "main");
  await writeFile(join(origin, "cart.js"), "exports.total = (items) => items.reduce((a, b) => a + b, 0) / items.length;\n");
  await writeFile(join(origin, "pay.js"), "exports.split = (cents, n) => Array(n).fill(cents / n);\n");
  await writeFile(join(origin, "search.js"), "exports.find = (items, q) => items.filter((item) => item.includes(q));\n");
  await writeFile(join(origin, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "bun test" } }));
  await writeFile(join(origin, "shop.test.js"), [
    "const { test, expect } = require('bun:test');",
    "const { total } = require('./cart.js');",
    "const { split } = require('./pay.js');",
    "const { find } = require('./search.js');",
    "test('mean of a cart', () => expect(total([2, 4])).toBe(3));",
    "test('an even split', () => expect(split(100, 4)).toEqual([25, 25, 25, 25]));",
    "test('nobody to split with', () => expect(split(100, 0)).toEqual([]));",
    "test('search is case sensitive', () => expect(find(['Apple', 'pear'], 'a')).toEqual(['pear']));", "",
  ].join("\n"));
  await sh(origin, "git", "add", ".");
  await sh(origin, "git", "commit", "-q", "-m", "init");
  await chmod(origin, 0o755);
  // The policy under test. Low-risk shop code runs with no person at all; payments stops once, at the landing.
  const autonomy = join(dir, "autonomy.md");
  await writeFile(autonomy, [
    "# Autonomy policy", "", "## defaults", "mode: enforce", "checkpoints: A=advisory B=advisory C=advisory",
    "landing: trail_ref", "watch: 1m", "",
    "## area: shop", "paths: cart.js", "risk: low", "The cart. Small, well tested.", "",
    "## area: payments", "paths: pay.js", "risk: low", "checkpoints: C=blocking", "Money. A person approves every landing.", "",
    "## area: search", "paths: search.js", "risk: low", "Search. Runs by itself.", "",
  ].join("\n"));
  await writeFile(join(dir, "thresholds.yaml"), `"${DECIDE_MODEL}": {}\n`);
  return autonomy;
}

const agent = new ScriptedAgent();
let cart: Trail | undefined;
let pay: Trail | undefined;
let search: Trail | undefined;
let heldSince = Date.now();

try {
  await act("boot", "A server starts from one repository link: no account, no database, no network", async () => {
    if (!args.includes("--server-only") && !args.includes("--no-build")) {
      const build = await $`bun run build`.cwd(root).quiet().nothrow();
      must(build.exitCode === 0, `the console did not build: ${build.stderr.toString().split("\n")[0]}`);
    }
    const autonomy = await fixtureRepository();
    const config = readConfig({
      EPHYRA_API_TOKEN: TOKEN, EPHYRA_DATA_DIR: join(dir, "data"), EPHYRA_REPO_ID: "shop", EPHYRA_REPO_URL: origin,
      EPHYRA_WATCH_EVERY_S: "1", EPHYRA_AUTONOMY_FILE: autonomy, EPHYRA_THRESHOLDS_FILE: join(dir, "thresholds.yaml"),
      EPHYRA_CONSOLE_DIR: join(root, "dist"),
    });
    server = await compose(config, {
      startJobs: false, agent, decide: fixtureDecide, runner: new LocalRunner(join(dir, "runner"), { trusted: true }),
      landing: async ({ ctx, ledger, probes, runProbe }) => ({
        adapters: [new PlainGitAdapter(ctx.repo.mirrorDir, undefined, ctx.repo.id, ctx.repo.mirrorDir, ledger)],
        watch: {
          prepare: async (trail) => measureWatchBaseline(ctx, trail, (await probes.list(trail)).map((probe) => probe.id)),
          coverage: async () => ({ source: "offline-OTLP-fixture", observedAt: ctx.clock.now().toISOString(), gaps: [] }),
          deployed: async (_trail, receipt) => ({
            sha: await sh(ctx.repo.mirrorDir, "git", "rev-parse", receipt.target), observedAt: ctx.clock.now().toISOString(),
            deployedAt: receipt.at, source: "offline-local-ref-fixture (not a production deployment)",
          }),
          runProbe: async (id, trail, key) => {
            const probe = (await probes.list(trail)).find((entry) => entry.id === id);
            return probe ? (await runProbe(probe, trail, key)).result : "unavailable";
          },
        },
      }),
    });
    const composed = server;
    http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => composed.app.fetch(request) });
    base = `http://127.0.0.1:${http.port}`;
    void (async () => {
      while (pumping) {
        try { await composed.jobs.drain(); } catch (error) { pumpError = error; }
        await Bun.sleep(40);
      }
    })();
    must((await fetch(`${base}/healthz`)).ok, "/healthz did not answer");
    const me = await get<{ principal: string; kind: string }>("/v1/me");
    return `${base}, signed in as ${me.principal} (${me.kind}); agent ${agent.name}, decide ${DECIDE_MODEL}`;
  });

  await act("drives-itself", "A production error becomes a quest and reaches production with no person deciding anything", async () => {
    await signal("RangeError", "total is NaN", "    at total (cart.js:1:40)\n    at checkout (shop.js:3:10)");
    let asked = 0;
    await until(async () => {
      asked = Math.max(asked, (await inbox()).filter((item) => item.blocking).length);
      const first = (await trails())[0];
      // The state turns to "watching" one job before the watch itself starts; wait for the watch, not the state.
      return first?.state === "watching" && (await detail(first.id)).events.some((event) => event.type === "watch_started");
    }, "the cart quest to land and be watched");
    cart = (await trails())[0]!;
    const { events } = await detail(cart.id);
    const types = events.map((event) => event.type);
    for (const type of ["triage_completed", "research_completed", "repro_completed", "plan_completed", "patch_completed", "proof_completed",
      "landing_completed", "watch_started"]) must(types.includes(type as TrailEvent["type"]), `the journal has no ${type}`);
    must(humanDecisions(events) === 0, "a person decided a checkpoint; this quest was meant to drive itself");
    must(asked === 0, "the inbox held a blocking item on the way");
    const landed = await sh(join(dir, "data"), "git", "--git-dir", "workspace.git", "show", `refs/heads/ephyra/${cart.id}:cart.js`);
    must(landed.includes("items.length ?"), "the fix is not on the quest's landing ref");
    return `${cart.short}: ${types.length} events, 0 human decisions, the fix is on its landing ref`;
  });

  await act("watches-then-sets", "It keeps watching production after landing, and closes the quest only when the window passes clean", async () => {
    const clock = server!.ctx.clock;
    const real = clock.now;
    clock.now = () => new Date(Date.now() + 120_000);
    try {
      await until(async () => (await current(cart!.id)).state === "closed", "the watch window to close");
    } finally { clock.now = real; }
    const view = await expected(await current(cart!.id));
    must(view.attention === "set", `the console model reads a closed quest as "${view.attention}"`);
    return `${cart!.short}: closed after its watch window (the clock was moved forward 120 s; telemetry is an offline fixture)`;
  });

  await act("unsticks-itself", "When a first try goes nowhere it tries a different way, and when its first fix is wrong its own proof sends it back", async () => {
    await signal("TypeError", "amount must be whole cents", "    at split (pay.js:1:30)\n    at charge (pay.js:1:5)");
    await until(async () => (await trails()).some((trail) => trail.id !== cart!.id && trail.state === "ready"), "the payments quest to reach its landing checkpoint");
    pay = (await trails()).find((trail) => trail.id !== cart!.id)!;
    const { events } = await detail(pay.id);
    const stumble = events.find((event) => event.type === "agent_failed");
    must(stumble?.type === "agent_failed" && stumble.data.step === "research" && stumble.data.retryable,
      "the first research turn failed, and the journal does not record it as something to retry");
    const second = agent.turns.find((turn) => turn.key === "payments:research:2");
    must(second && /materially different/.test(second.recovery), "the second research turn was not told to try a different hypothesis");
    const proofs = events.flatMap((event) => event.type === "proof_completed" ? [event.data.bundle.passed] : []);
    must(proofs.length === 2 && proofs[0] === false && proofs[1] === true, `expected a failed proof then a passing one, saw ${JSON.stringify(proofs)}`);
    const recovery = await recoveryOf(pay);
    const plan = (step: string, n: number) => recovery.find((entry) => entry.step === step && entry.attempt === n)?.strategy;
    must(plan("research", 2) === "alternate_hypothesis" && plan("patch", 2) === "alternate_hypothesis", "the kept recovery plans do not show the change of approach: "
      + (recovery.map((entry) => `${entry.step} ${entry.attempt} ${entry.strategy}`).join(", ") || "none could be read"));
    const retreats = journeyOf(events).filter((step) => step.kind === "retreat").length;
    must(retreats >= 1, "the journey the console draws from these events shows no retreat");
    must(humanDecisions(events) === 0, "a person stepped in before the landing checkpoint");
    return `${pay.short}: research retried with a different hypothesis; proof failed, sank back ${retreats}×, the second patch proved`;
  });

  await act("stops-where-told", "It stops only where the policy says a person decides, and waits there", async () => {
    const item = (await inbox()).find((entry) => entry.trailId === pay!.id && entry.kind === "checkpoint");
    must(item?.checkpoint === "C" && item.blocking, "the inbox has no blocking landing checkpoint for the payments quest");
    await Bun.sleep(700);
    const now = await current(pay!.id);
    must(now.state === "ready", `the quest moved to "${now.state}" without an approval`);
    const view = await expected(now);
    must(view.attention === "needs_you" && view.action?.kind === "decide", `the console model reads it as "${view.attention}"`);
    must(view.retreats >= 1 && view.attempts.length >= 2, "the console model lost the quest's history of retreats and attempts");
    return `${pay!.short} waits at checkpoint C with ${view.retreats} retreat and ${view.attempts.length} recorded attempts`;
  });

  await act("keeps-working", "While one quest waits for you, another keeps working on its own problem", async () => {
    // The second patch of this quest waits for the script, so a browser can look at a quest in the middle of recovering.
    const hold = agent.hold("search:patch:2");
    let there = false;
    void hold.reached.then(() => { there = true; });
    await signal("TypeError", "Cannot read properties of null (reading 'includes')", "    at find (search.js:1:50)\n    at results (search.js:1:5)");
    await until(async () => there, "the search quest to start its second patch");
    heldSince = Date.now();
    search = (await trails()).find((trail) => trail.id !== cart!.id && trail.id !== pay!.id)!;
    must(search.state === "patching" && search.attempts.proof === 1, `expected patching after one failed proof, saw ${search.state} after ${search.attempts.proof}`);
    const view = await expected(search);
    must(view.attention === "recovering", `the console model reads it as "${view.attention}"`);
    must((await current(pay!.id)).state === "ready", "the payments quest did not keep waiting");
    return `${search.short} is on its second patch while ${pay!.short} waits. The console should say: "${await sentenceNow()}"`;
  });

  await act("asks-a-person", "When it cannot find out by itself, it asks the one person who would know", async () => {
    const response = await fetch(`${base}/v1/questions`, { headers });
    must(response.status !== 404, "this server has no /v1/questions. Asking people is wired only into composeApplication, so nothing here can ask anyone");
    must(response.ok, `GET /v1/questions answered ${response.status}`);
    const open = (await response.json() as InvestigationQuestion[]).filter((question) => question.status === "awaiting_answer");
    must(open.length > 0, "no quest is asking anyone. Stage one: a quest that stops on a missing fact, and a fixture contact who covers its area");
    const question = open[0]!;
    must(question.recipient !== null, "the question is addressed to nobody in particular");
    must(question.checks.some((check) => check.phase === "question" && check.accepted), "the question went out without being checked first");
    const view = await expected(await current(question.trailId));
    must(view.attention === "asking", `the console model reads the asking quest as "${view.attention}"`);
    // Still to add here once a contact fixture exists: answer over HTTP, see the answer checked, see the quest resume.
    return `${view.short} is asking ${question.recipient!.alias}: "${question.question}"`;
  }, { gate: false });

  const carriesOn = () => act("carries-on", "Left alone, the recovering quest finishes its second fix and lands it by itself", async () => {
    must(search, "the search quest never started");
    agent.releaseAll();
    await until(async () => ["watching", "closed"].includes((await current(search!.id)).state), "the search quest to land");
    const { events } = await detail(search!.id);
    const proofs = events.flatMap((event) => event.type === "proof_completed" ? [event.data.bundle.passed] : []);
    must(proofs.length === 2 && proofs[0] === false && proofs[1] === true, `expected a failed proof then a passing one, saw ${JSON.stringify(proofs)}`);
    must(humanDecisions(events) === 0, "a person decided a checkpoint; this quest was meant to drive itself");
    return `${search!.short}: held for ${Math.round((Date.now() - heldSince) / 1000)} s, then patched, proved and landed with 0 human decisions`;
  }, { always: true });

  if (args.includes("--server-only")) {
    const hold = Number(args.find((arg) => arg.startsWith("--hold="))?.slice(7) ?? 0);
    if (hold > 0 && !broken) await Bun.sleep(hold * 1000);
    await carriesOn();
  }

  if (!args.includes("--server-only")) {
    const browser = await launch();
    const loop = `${base}/app/#/loop`;
    const prepare = async (context: BrowserContext) => {
      await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addInitScript(([key, value]) => sessionStorage.setItem(key!, value!),
        ["ephyra.connection", JSON.stringify({ token: TOKEN, principal: PRINCIPAL })]);
    };
    try {
      await act("console-agrees", "The console shows the same quests, in the same stage and state, that the server holds", async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await prepare(context);
        const page = await context.newPage();
        try {
          await page.goto(loop);
          await page.waitForSelector("[data-loop-fleet]", { timeout: 10_000 }).catch(() => {
            throw new Error("the console has no loop view at #/loop ([data-loop-fleet] never appeared)");
          });
          const views = await Promise.all((await trails()).map(expected));
          for (const view of views) {
            const row = page.locator(`[data-quest="${view.short}"]`).first();
            must(await row.count() === 1, `${view.short} is on the server but not on the page`);
            const shown = `${await row.getAttribute("data-stage")}/${await row.getAttribute("data-attention")}`;
            must(shown === `${view.stage.id}/${view.attention}`, `${view.short} is ${view.stage.id}/${view.attention} on the server and ${shown} on the page`);
          }
          const sentence = (await page.locator("[data-loop-fleet]").innerText()).replace(/\s+/g, " ").trim();
          must(sentence === fleetView(views).sentence, `the page says "${sentence}", the server's state says "${fleetView(views).sentence}"`);
          await mkdir(join(root, ".screens", "e2e"), { recursive: true });
          await page.screenshot({ path: join(root, ".screens", "e2e", "loop-wide.png") });
          return `${views.length} quests agree; "${sentence}"`;
        } finally { await context.close(); }
      });

      if (!broken) {
        for (const outcome of await runAcceptance({ target: "console", url: loop, browser, prepare })) {
          results.push({ id: `ui:${outcome.id}`, promise: outcome.promise, status: outcome.status, detail: outcome.detail });
        }
        const approved = results.find((entry) => entry.id === "ui:approve")?.status === "pass";
        if (!approved) broken = "ui:approve";
      } else {
        for (const criterion of CRITERIA) {
          if (criterion.only === "lab") continue;
          results.push({ id: `ui:${criterion.id}`, promise: criterion.promise, status: "not reached", detail: `stopped at "${broken}"` });
        }
      }

      await carriesOn();

      await act("approval-lands", "One approval in the browser is recorded as yours, and the quest lands and is watched", async () => {
        const { events } = await detail(pay!.id);
        const decided = lastDecision(events);
        if (decided?.by !== "human" || decided.verdict !== "approve") throw new Error("the journal holds no human approval for the landing");
        must(decided.who === PRINCIPAL, `the approval is recorded as "${decided.who}", not "${PRINCIPAL}"`);
        await until(async () => (await current(pay!.id)).state === "watching", "the payments quest to land");
        const landed = await sh(join(dir, "data"), "git", "--git-dir", "workspace.git", "show", `refs/heads/ephyra/${pay!.id}:pay.js`);
        must(landed.includes("Math.floor"), "the proven patch is not what landed");
        return `${pay!.short}: approved by ${decided.who}, landed, watching`;
      });

      await act("stays-live", "The page follows the loop by itself: no reload between watching and set", async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await prepare(context);
        const page = await context.newPage();
        const clock = server!.ctx.clock;
        const real = clock.now;
        try {
          await page.goto(loop);
          await page.waitForSelector(`[data-quest="${pay!.short}"][data-stage="watch"]`, { timeout: 10_000 });
          await page.evaluate(() => { (window as unknown as { e2eMark: number }).e2eMark = 1; });
          clock.now = () => new Date(Date.now() + 120_000);
          await until(async () => (await trails()).every((trail) => trail.state === "closed"), "every quest to close");
          await page.waitForSelector(`[data-quest="${pay!.short}"][data-attention="set"]`, { timeout: 10_000 }).catch(() => {
            throw new Error("the server closed the quest but the open page never showed it");
          });
          must(await page.evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark === 1), "the page reloaded to catch up");
          const sentence = (await page.locator("[data-loop-fleet]").innerText()).replace(/\s+/g, " ").trim();
          const wanted = await sentenceNow();
          must(sentence === wanted, `the page ends on "${sentence}", the server's state says "${wanted}"`);
          await page.screenshot({ path: join(root, ".screens", "e2e", "loop-finished.png") });
          return `"${sentence}"`;
        } finally {
          clock.now = real;
          await context.close();
        }
      });
    } finally { await browser.close(); }
  }
} finally {
  agent.releaseAll();
  pumping = false;
  await Bun.sleep(80);
  (http as ReturnType<typeof Bun.serve> | null)?.stop(true);
  await (server as Composed | null)?.close().catch(() => {});
  if (args.includes("--keep")) console.log(`Kept ${dir}`); else await rm(dir, { recursive: true, force: true });
}

function humanDecisions(events: readonly TrailEvent[]): number {
  return events.filter((event) => event.type === "checkpoint_decided" && event.data.decision.by === "human").length;
}

function lastDecision(events: readonly TrailEvent[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "checkpoint_decided" && event.data.checkpoint === "C") return event.data.decision;
  }
  return null;
}

const mark: Record<Status, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", "not reached": "----" };
for (const entry of results) {
  console.log(`${mark[entry.status]}  ${entry.id.padEnd(20)} ${entry.promise}`);
  console.log(`      ${"".padEnd(20)} ${entry.detail}`);
}
const count = (status: Status) => results.filter((entry) => entry.status === status).length;
console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} not exercised, ${count("not reached")} not reached, of ${results.length}.`);
if (!args.includes("--server-only")) {
  console.log("Not covered here yet: sign in, connect a repository, automatic setup. See design/09-console-redesign.md §8.");
}
process.exit(results.every((entry) => entry.status === "pass") ? 0 : 1);
