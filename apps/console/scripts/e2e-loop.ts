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
 * (`fixture/e2e-decide-1`), the model that words a question (`fixture/e2e-draft-1`), the one contact it can ask
 * ("Fixture maintainer") and the production telemetry behind the watch ("offline fixture"). No network is used.
 *
 * The run exits 0 only when every act passes. A check that could not be exercised counts as a failure: this script is the
 * definition of "it works end to end", so nothing in it is allowed to pass by being skipped.
 */
import { $ } from "bun";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type {
  AgentResult, AgentTask, CodingAgent, DecideBackend, InvestigationQuestion, JudgementAnswer, JudgementRequest, JudgementResponse,
  PeopleConnection, Runner, RunnerHandle, Trail, TrailEvent,
} from "@ephyra/core";
import type { AgentRunOptions } from "../../../packages/agent/src/index.ts";
import { PlainGitAdapter } from "../../../packages/forge/src/index.ts";
import { LocalRunner } from "../../../packages/runner/src/index.ts";
import { SecretBox } from "../../server/src/auth/crypto.ts";
import { compose, type Composed } from "../../server/src/compose.ts";
import { readConfig } from "../../server/src/config.ts";
import type { DraftModel } from "../../server/src/velum.ts";
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
const DRAFT_MODEL = "fixture/e2e-draft-1";
/** The one person this server can ask. They are not the operator at the console, so the operator only watches the question. */
const MAINTAINER = "did:key:e2e-maintainer";
const ANSWER = "An order with no parcels is charged nothing: the rate is 0.";
/** How long a landed change is watched before its quest closes. Real seconds on the real clock: nothing is fast-forwarded. */
const WATCH_S = 12;
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
  /** A fact the repository does not hold. The first reproduction stops on it; the second, after an answer, goes through. */
  missing?: string;
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
  shipping: {
    file: "ship.js", hypothesis: "rate() divides the charge by the number of parcels, which can be zero.",
    plan: "Charge nothing when there are no parcels.",
    missing: "The repository does not say what an order with no parcels should be charged, so no failing probe can be written yet",
    probe: "const {rate}=require(\"./ship.js\"); if(rate(500, 0) !== 0) process.exit(1)",
    patches: ["exports.rate = (cents, parcels) => parcels > 0 ? cents / parcels : 0;\n"],
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
      // Reproducing needs to know what "right" is. Without that fact the turn ends with no probe, and says why.
      if (script.missing && n === 1) return { ok: true, artefacts: {}, outputs: {}, usage, sessions: [], error: script.missing };
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

/** Words the question a stopped quest sends. It is a fixed text under its own identity: no model writes it. */
const fixtureDraft: DraftModel = {
  kind: "fake", billedTo: "byok",
  complete: async () => ({
    text: JSON.stringify({
      recipient: "maintainer", question: "What should an order with no parcels be charged for shipping?",
      reason: "The reproduction needs the expected charge before it can say the current one is wrong.",
      acceptance: "State the charge for an order with no parcels.",
    }),
    engine: DRAFT_MODEL, tokens: null, costMicrousd: null,
  }),
};
const people = (): PeopleConnection => ({
  enabled: true, workspaceId: "shop", webhookUrl: null, keyConfigured: false, updatedAt: new Date().toISOString(),
  contacts: [{ id: "maintainer", alias: "Fixture maintainer", roles: ["maintainer"], areas: [], did: MAINTAINER }],
});

/**
 * A decide backend that always answers "yes, ours, fix it" and accepts every question and answer it is asked to check,
 * under its own identity so nothing mistakes it for a model. What a real check rejects is covered by the server's tests.
 */
const fixtureDecide: DecideBackend = {
  kind: "selfhosted:fixture", alias: "e2e-decide", supports: ["noul", "choice", "score"],
  async decide(request: JudgementRequest): Promise<JudgementResponse> {
    const answers: Record<string, JudgementAnswer> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "noul") answers[key] = { type: "noul", noul: 0.95 };
      else if (question.type === "score") answers[key] = { type: "score", score: 1, probabilities: { "1": 0.95 }, legend: {}, confidence: 0.95 };
      else {
        const offered = Object.keys(question.criteria);
        // A check of a question or an answer offers exactly accept and reject, and wants a probability for each.
        if (offered.length === 2 && offered.includes("accept") && offered.includes("reject")) {
          answers[key] = { type: "choice", choice: "accept", probabilities: { accept: 0.97, reject: 0.03 }, confidence: 0.97 };
          continue;
        }
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

/** The recovery plans the server kept for a quest, as it hands them out with the quest itself. */
async function recoveryOf(trail: Trail): Promise<RecoveryArtifact[]> {
  return parseRecovery((await detail(trail.id)).artefacts);
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
  await writeFile(join(origin, "ship.js"), "exports.rate = (cents, parcels) => cents / parcels;\n");
  await writeFile(join(origin, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "bun test" } }));
  await writeFile(join(origin, "shop.test.js"), [
    "const { test, expect } = require('bun:test');",
    "const { total } = require('./cart.js');",
    "const { split } = require('./pay.js');",
    "const { find } = require('./search.js');",
    "const { rate } = require('./ship.js');",
    "test('mean of a cart', () => expect(total([2, 4])).toBe(3));",
    "test('an even split', () => expect(split(100, 4)).toEqual([25, 25, 25, 25]));",
    "test('nobody to split with', () => expect(split(100, 0)).toEqual([]));",
    "test('search is case sensitive', () => expect(find(['Apple', 'pear'], 'a')).toEqual(['pear']));",
    "test('shipping per parcel', () => expect(rate(500, 2)).toBe(250));", "",
  ].join("\n"));
  await sh(origin, "git", "add", ".");
  await sh(origin, "git", "commit", "-q", "-m", "init");
  await chmod(origin, 0o755);
  // The policy under test. Low-risk shop code runs with no person at all; payments stops once, at the landing.
  const autonomy = join(dir, "autonomy.md");
  await writeFile(autonomy, [
    "# Autonomy policy", "", "## defaults", "mode: enforce", "checkpoints: A=advisory B=advisory C=advisory",
    "landing: trail_ref", `watch: ${WATCH_S}s`, "",
    "## area: shop", "paths: cart.js", "risk: low", "The cart. Small, well tested.", "",
    "## area: payments", "paths: pay.js", "risk: low", "checkpoints: C=blocking", "Money. A person approves every landing.", "",
    "## area: search", "paths: search.js", "risk: low", "Search. Runs by itself.", "",
    "## area: shipping", "paths: ship.js", "risk: low", "Shipping rates. Runs by itself.", "",
  ].join("\n"));
  await writeFile(join(dir, "thresholds.yaml"), `"${DECIDE_MODEL}": {}\n`);
  return autonomy;
}

const agent = new ScriptedAgent();
let cart: Trail | undefined;
let pay: Trail | undefined;
let search: Trail | undefined;
let ship: Trail | undefined;
let asked: InvestigationQuestion | undefined;
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
      // One fixture contact, reached through the console inbox. Nothing is sent anywhere.
      questions: {
        did: MAINTAINER, workspaceId: "shop", publicOrigin: "http://127.0.0.1", model: async () => fixtureDraft,
        box: await SecretBox.fromBase64(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")),
        connection: async () => ({ settings: people() }),
        fetcher: async () => { throw new Error("the end-to-end run uses no network"); },
      },
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
      return first !== undefined && ["watching", "closed"].includes(first.state)
        && (await detail(first.id)).events.some((event) => event.type === "watch_started");
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
    await until(async () => (await current(cart!.id)).state === "closed", "the watch window to close");
    const { events } = await detail(cart!.id);
    const done = events.find((event) => event.type === "watch_completed");
    if (done?.type !== "watch_completed" || done.data.outcome !== "clean") throw new Error("the quest closed without a clean watch on record");
    // The window is counted from the landing, which is a moment before the first observation.
    const landed = events.find((event) => event.type === "landing_completed")!;
    const watched = (Date.parse(done.at) - Date.parse(landed.at)) / 1000;
    must(watched >= WATCH_S, `the quest closed after ${watched.toFixed(1)} s, before its ${WATCH_S} s window had passed`);
    const view = await expected(await current(cart!.id));
    must(view.attention === "set", `the console model reads a closed quest as "${view.attention}"`);
    return `${cart!.short}: watched for ${watched.toFixed(0)} s of real time, then closed clean (telemetry is an offline fixture)`;
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

  await act("asks-a-person", "When it cannot find out by itself, it asks the one person who would know", async () => {
    await signal("RangeError", "shipping rate is Infinity", "    at rate (ship.js:1:40)\n    at quote (ship.js:1:5)");
    // This runs before the next act holds an agent turn open: a held turn occupies the job loop, and nothing new starts.
    const others = () => [cart, pay].map((trail) => trail?.id);
    await until(async () => {
      ship = (await trails()).find((trail) => !others().includes(trail.id));
      if (!ship || ship.state !== "parked") return false;
      asked = (await questions()).find((question) => question.trailId === ship!.id && question.status === "awaiting_answer");
      // The question is saved once it passes its check and again once it is delivered. Wait for the delivery.
      return asked?.delivery.status === "sent";
    }, "the shipping quest to stop on the missing fact and ask about it");
    const question = asked!;
    const { events } = await detail(ship!.id);
    const stopped = events.find((event) => event.type === "repro_completed");
    must(stopped?.type === "repro_completed" && !stopped.data.ok, "the journal does not record a reproduction that could not be written");
    must(question.recipient?.did === MAINTAINER, `the question is addressed to ${question.recipient?.did ?? "nobody"}, not the fixture maintainer`);
    must(question.delivery.status === "sent" && question.delivery.kind === "inbox", `the question's delivery reads ${question.delivery.kind}/${question.delivery.status}`);
    const checked = question.checks.find((check) => check.phase === "question");
    must(checked?.accepted && checked.model === DECIDE_MODEL, "the question went out without being checked first");
    const view = await expected(await current(ship!.id));
    must(view.attention === "asking", `the console model reads the asking quest as "${view.attention}" for someone it was not addressed to`);
    // The operator at the console is not who was asked, so the server will not take an answer from them.
    const refused = await fetch(`${base}/v1/questions/${ship!.id}/${question.id}/answer`, { method: "POST", headers, body: JSON.stringify({ text: ANSWER }) });
    must(refused.status === 403, `an answer from ${PRINCIPAL}, who was not asked, was answered ${refused.status} instead of refused`);
    must((await current(ship!.id)).state === "parked", "the refused answer moved the quest");
    return `${view.short} stopped and asked ${question.recipient!.alias}: "${question.question}" (worded by ${DRAFT_MODEL}, checked by ${checked!.model})`;
  }, { gate: false });

  await act("keeps-working", "While one quest waits for you, another keeps working on its own problem", async () => {
    // The second patch of this quest waits for the script, so a browser can look at a quest in the middle of recovering.
    const hold = agent.hold("search:patch:2");
    let there = false;
    void hold.reached.then(() => { there = true; });
    await signal("TypeError", "Cannot read properties of null (reading 'includes')", "    at find (search.js:1:50)\n    at results (search.js:1:5)");
    await until(async () => there, "the search quest to start its second patch");
    heldSince = Date.now();
    search = (await trails()).find((trail) => ![cart!.id, pay!.id, ship?.id].includes(trail.id))!;
    must(search.state === "patching" && search.attempts.proof === 1, `expected patching after one failed proof, saw ${search.state} after ${search.attempts.proof}`);
    const view = await expected(search);
    must(view.attention === "recovering", `the console model reads it as "${view.attention}"`);
    must((await current(pay!.id)).state === "ready", "the payments quest did not keep waiting");
    return `${search.short} is on its second patch while ${pay!.short} waits. The console should say: "${await sentenceNow()}"`;
  });

  /** The person who was asked answers. In a browser when there is one, so the console's own form is what gets used. */
  const answerResumes = (answer: (question: InvestigationQuestion) => Promise<string>) =>
    act("answer-resumes", "An answer from the person it asked is checked, recorded, and the quest carries on to production by itself", async () => {
      must(ship && asked, "no quest asked anything");
      const how = await answer(asked!);
      const saved = (await get<InvestigationQuestion | null>(`/v1/questions/${ship!.id}/${asked!.id}`));
      must(saved?.status === "answered" && saved.answer?.accepted === true, `the question reads "${saved?.status}" after the answer`);
      must(saved!.answer!.text === ANSWER, "the recorded answer is not the text that was sent");
      must(saved!.checks.some((check) => check.phase === "answer" && check.accepted && check.model === DECIDE_MODEL), "the answer was not checked before it was used");
      await until(async () => ["watching", "closed"].includes((await current(ship!.id)).state), "the shipping quest to land after its answer");
      const { events } = await detail(ship!.id);
      const resumed = events.find((event) => event.type === "resumed");
      must(resumed?.actor.kind === "system" && resumed.actor.id === `answer:${asked!.id}`, "the journal does not tie the resume to the answer");
      const repros = events.flatMap((event) => event.type === "repro_completed" ? [event.data.ok] : []);
      must(repros.length === 2 && repros[0] === false && repros[1] === true, `expected a reproduction that stopped, then one that worked; saw ${JSON.stringify(repros)}`);
      must(humanDecisions(events) === 0, "a person decided a checkpoint; the answer was meant to be the only thing a person gave");
      const landed = await sh(join(dir, "data"), "git", "--git-dir", "workspace.git", "show", `refs/heads/ephyra/${ship!.id}:ship.js`);
      must(landed.includes("parcels > 0"), "the fix that used the answer is not on the quest's landing ref");
      return `${ship!.short}: ${how}; reproduced, patched, proved and landed with 0 human decisions`;
    });
  const answerOverHttp = async (question: InvestigationQuestion) => {
    const response = await fetch(`${base}/v1/questions/${question.trailId}/${question.id}/answer`, {
      method: "POST", headers: { ...headers, "X-Ephyra-Principal": MAINTAINER }, body: JSON.stringify({ text: ANSWER }),
    });
    must(response.ok, `the maintainer's answer was answered ${response.status}`);
    return "answered over HTTP as the fixture maintainer";
  };

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
    await answerResumes(answerOverHttp);
  }

  if (!args.includes("--server-only")) {
    const browser = await launch();
    const loop = `${base}/app/#/loop`;
    const signedInAs = (principal: string) => async (context: BrowserContext) => {
      await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addInitScript(([key, value]) => sessionStorage.setItem(key!, value!),
        ["ephyra.connection", JSON.stringify({ token: TOKEN, principal })]);
    };
    const prepare = signedInAs(PRINCIPAL);
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

      // Pictures of the real page at this moment, for people. Nothing is asserted here; the checks below do that.
      if (!broken) {
        const picture = async (name: string, size: { width: number; height: number }, scheme: "light" | "dark", keys: string[] = []) => {
          const context = await browser.newContext({ viewport: size, reducedMotion: "reduce", colorScheme: scheme });
          await prepare(context);
          const page = await context.newPage();
          try {
            await page.goto(loop);
            await page.waitForSelector("[data-detail]", { timeout: 10_000 });
            await page.locator("body").click({ position: { x: 2, y: 2 } });
            for (const key of keys) { await page.keyboard.press(key); await page.waitForTimeout(250); }
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(root, ".screens", "e2e", `${name}.png`) });
          } catch { /* A missing picture fails nothing. */ } finally { await context.close(); }
        };
        await picture("loop-dark", { width: 1440, height: 900 }, "dark");
        await picture("loop-phone", { width: 390, height: 844 }, "light");
        await picture("loop-phone-dark", { width: 390, height: 844 }, "dark");
        await picture("loop-recovering", { width: 1440, height: 900 }, "light", ["j"]);
        await picture("loop-asking", { width: 1440, height: 900 }, "light", ["j", "j"]);
        await picture("loop-hood-effects", { width: 1440, height: 900 }, "light", ["j", "i", "Tab", "Tab", "ArrowRight"]);
      }

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
        await until(async () => ["watching", "closed"].includes((await current(pay!.id)).state), "the payments quest to land");
        const landed = await sh(join(dir, "data"), "git", "--git-dir", "workspace.git", "show", `refs/heads/ephyra/${pay!.id}:pay.js`);
        must(landed.includes("Math.floor"), "the proven patch is not what landed");
        return `${pay!.short}: approved by ${decided.who}, landed, ${(await current(pay!.id)).state}`;
      });

      // A page the operator leaves open from here on. It is never reloaded; "stays-live" checks what it ends up showing.
      let live: { context: BrowserContext; page: Page; before: string | null } | null = null;
      if (!broken && ship) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await prepare(context);
        const page = await context.newPage();
        await page.goto(loop);
        const row = page.locator(`[data-quest="${ship.short}"]`).first();
        await row.waitFor({ timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => { (window as unknown as { e2eMark: number }).e2eMark = 1; });
        live = { context, page, before: await row.getAttribute("data-attention").catch(() => null) };
      }

      await answerResumes(async (question) => {
        // The same console, opened by the person who was asked. For them the quest is the one thing that needs them.
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
        await signedInAs(MAINTAINER)(context);
        const page = await context.newPage();
        try {
          await page.goto(loop);
          const strip = page.locator(`[data-needs-you="${ship!.short}"]`);
          await strip.waitFor({ timeout: 10_000 }).catch(() => {
            throw new Error("the console does not tell the person who was asked that a quest is waiting on them");
          });
          await strip.locator("[data-primary]").click();
          const box = page.locator(`[data-detail="${ship!.short}"] [data-answer] textarea`);
          await box.waitFor({ timeout: 5_000 }).catch(() => { throw new Error("the console offers no way to answer the question"); });
          must(await box.evaluate((el) => el === document.activeElement), "pressing the action did not put the cursor in the answer");
          must((await page.locator(`[data-detail="${ship!.short}"] [data-question]`).innerText()).includes(question.question),
            "the question is not shown beside the place to answer it");
          await box.fill(ANSWER);
          await page.locator(`[data-detail="${ship!.short}"] [data-answer] button[type="submit"]`).click();
          await page.waitForFunction(() => (document.querySelector("[data-toast]")?.textContent ?? "").length > 0, null, { timeout: 10_000 });
          await page.waitForSelector(`[data-needs-you="${ship!.short}"]`, { state: "detached", timeout: 10_000 }).catch(() => {
            throw new Error("the quest still says it needs the person after they answered");
          });
          await page.screenshot({ path: join(root, ".screens", "e2e", "loop-answered.png") });
          return "answered in the console by the fixture maintainer";
        } finally { await context.close(); }
      });

      await act("stays-live", "An open page follows the loop by itself: from asking a person to set, with no reload", async () => {
        must(live, "no page was left open to watch");
        must(live!.before === "asking", `the page was opened while ${ship!.short} read "${live!.before}", not while it was asking`);
        await until(async () => (await trails()).every((trail) => trail.state === "closed"), "every quest to close");
        await live!.page.waitForSelector(`[data-quest="${ship!.short}"][data-attention="set"]`, { timeout: 10_000 }).catch(() => {
          throw new Error("the server closed the quest but the open page never showed it");
        });
        must(await live!.page.evaluate(() => (window as unknown as { e2eMark?: number }).e2eMark === 1), "the page reloaded to catch up");
        const sentence = (await live!.page.locator("[data-loop-fleet]").innerText()).replace(/\s+/g, " ").trim();
        const wanted = await sentenceNow();
        must(sentence === wanted, `the page ends on "${sentence}", the server's state says "${wanted}"`);
        await live!.page.screenshot({ path: join(root, ".screens", "e2e", "loop-finished.png") });
        return `${ship!.short} went asking → set on a page opened before the answer; it ends on "${sentence}"`;
      });
      await live?.context.close();
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
