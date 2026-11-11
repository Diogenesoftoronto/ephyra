/**
 * Independent end-to-end driver for the Ephyra loop page. Written separately from e2e-loop.ts, with its own fixture repo,
 * its own policy, its own scripted agent and its own assertions.
 *   env -u LD_LIBRARY_PATH bun --no-env-file scripts/independent-e2e.ts
 * Screenshots and logs: /tmp/claude-1000/sonnet-e2e/
 */
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
import { fleetView, parseRecovery, questView, type QuestView } from "../src/loop/model.ts";
import { launch } from "./browser.ts";

const OUT = "/tmp/claude-1000/sonnet-e2e";
await mkdir(OUT, { recursive: true });
const TOKEN = "indep-e2e-service-token";
const ME = "tester-ana";
const CONTACT = "did:key:tester-contact";
const DECIDE_MODEL = "fixture/indep-decide-1";
const WATCH_S = 4;
const H = (principal: string) => ({ Authorization: `Bearer ${TOKEN}`, "X-Ephyra-Principal": principal, "content-type": "application/json" });

// ───────── reporting ─────────
type Row = { id: string; name: string; status: "PASS" | "FAIL" | "COULD NOT TEST"; detail: string };
const rows: Row[] = [];
const notes: string[] = [];
const consoleProblems: string[] = [];
const ok = (cond: unknown, why: string): void => { if (!cond) throw new Error(why); };
async function check(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  try { const detail = await fn(); rows.push({ id, name, status: "PASS", detail }); console.log(`PASS ${id} ${detail}`); }
  catch (e) { const detail = e instanceof Error ? e.message : String(e); rows.push({ id, name, status: "FAIL", detail }); console.log(`FAIL ${id} ${detail}`); }
}
const skip = (id: string, name: string, why: string) => { rows.push({ id, name, status: "COULD NOT TEST", detail: why }); console.log(`SKIP ${id} ${why}`); };

// ───────── fixture repository ─────────
function sh(cwd: string, ...cmd: string[]): Promise<string> {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost" };
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => {
    if (code !== 0) throw new Error(`${cmd.join(" ")}: ${err.trim()}`);
    return out.trim();
  });
}
async function exec(runner: Runner, handle: RunnerHandle, cmd: string[]): Promise<string> {
  let out = ""; let exit = -1;
  for await (const part of runner.exec(handle, cmd, { deadlineMs: 30_000 })) { if ("chunk" in part) out += part.chunk; else exit = part.exit; }
  if (exit !== 0) throw new Error(`${cmd.join(" ")} failed: ${out}`);
  return out.trim();
}

type Script = { file: string; hypothesis: string; plan: string; probe: string; patches: string[]; missing?: string };
const SCRIPT: Record<string, Script> = {
  inventory: { file: "inventory.js", hypothesis: "qty() reads stock of a missing item.", plan: "Guard the missing item.",
    probe: `const {qty}=require("./inventory.js"); try{qty({})}catch(e){process.exit(1)}`,
    patches: ["exports.qty = (item) => (item && item.stock ? item.stock.qty : 0);\n"] },
  billing: { file: "billing.js", hypothesis: "net() divides by NaN when pct is missing.", plan: "Default pct to 0.",
    probe: `const {net}=require("./billing.js"); if(!Number.isFinite(net(100)))process.exit(1)`,
    patches: ["exports.net = (gross, pct) => gross / (1 + (pct || 0) / 100);\n"] },
  refunds: { file: "refunds.js", hypothesis: "refund() reads fee of an undefined hold-back.", plan: "Treat a missing hold-back as no fee.",
    probe: `const {refund}=require("./refunds.js"); try{refund(100)}catch(e){process.exit(1)}`,
    patches: ["exports.refund = (paid, kept) => paid - ((kept && kept.fee) || 0);\n",
      "exports.refund = (paid, kept) => Math.max(0, paid - ((kept && kept.fee) || 0));\n"] },
  invoices: { file: "invoices.js", hypothesis: "number() calls toString on undefined.", plan: "Default to 0.",
    probe: `const {number}=require("./invoices.js"); try{number()}catch(e){process.exit(1)}`,
    patches: ["exports.number = (n) => String(n == null ? 0 : n).padStart(6, \"0\");\n"] },
  taxes: { file: "taxes.js", hypothesis: "round() calls toFixed on null.", plan: "Coerce null to 0.",
    probe: `const {round}=require("./taxes.js"); try{round(null)}catch(e){process.exit(1)}`,
    patches: ["exports.round = (x) => Number(x || 0).toFixed(2);\n"] },
  coupons: { file: "coupons.js", hypothesis: "off() reads value of a missing coupon.", plan: "No coupon takes nothing off.",
    missing: "The repository does not say what a missing coupon should take off, so no failing probe can be written yet",
    probe: `const {off}=require("./coupons.js"); try{off(10)}catch(e){process.exit(1)}`,
    patches: ["exports.off = (price, code) => price - (code ? code.value : 0);\n"] },
  giftcards: { file: "giftcards.js", hypothesis: "balance() reads cents of a missing card.", plan: "A missing card has no balance.",
    missing: "The repository does not say what an unknown gift card is worth, so no failing probe can be written yet",
    probe: `const {balance}=require("./giftcards.js"); try{balance()}catch(e){process.exit(1)}`,
    patches: ["exports.balance = (card) => (card && card.cents ? card.cents / 100 : 0);\n"] },
  ledger: { file: "ledger.js", hypothesis: "total() reads rows of a null book.", plan: "A null book has no rows.",
    probe: `const {total}=require("./ledger.js"); try{total(null)}catch(e){process.exit(1)}`,
    patches: ["exports.total = (book) => (book && book.rows ? book.rows : []).reduce((a, r) => a + r, 0);\n"] },
};

type Hold = { reached: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void };
class Agent implements CodingAgent {
  readonly name = "scripted/indep";
  readonly turns: string[] = [];
  private counts = new Map<string, number>();
  private holds = new Map<string, Hold>();
  hold(key: string): Hold {
    let arrive = () => {}; let release = () => {};
    const h = { reached: new Promise<void>((r) => { arrive = r; }), released: new Promise<void>((r) => { release = r; }), arrive, release };
    this.holds.set(key, h); return h;
  }
  releaseAll() { for (const h of this.holds.values()) h.release(); }
  async run(task: AgentTask, runner: Runner, handle: RunnerHandle, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const area = task.trail.area ?? "";
    const s = SCRIPT[area];
    if (!s) throw new Error(`no script for area "${area}"`);
    const ck = `${task.trail.id}:${task.step}`;
    const n = (this.counts.get(ck) ?? 0) + 1; this.counts.set(ck, n);
    const key = `${area}:${task.step}:${n}`; this.turns.push(key);
    await opts.onEvent?.({ type: "message", text: `Scripted: ${key}` });
    const h = this.holds.get(key); if (h) { h.arrive(); await h.released; }
    const usage = { tokens: 10, costMicrousd: null, model: "scripted/indep" };
    const git = (...a: string[]) => exec(runner, handle, ["git", "-c", "user.name=agent", "-c", "user.email=agent@localhost", ...a]);
    if (task.step === "research") return { ok: true, artefacts: { "hypothesis.md": s.hypothesis }, outputs: {}, usage, sessions: [] };
    if (task.step === "plan") return { ok: true, artefacts: { "plan.md": s.plan }, outputs: {}, usage, sessions: [] };
    if (task.step === "repro") {
      if (s.missing && n === 1) return { ok: true, artefacts: {}, outputs: {}, usage, sessions: [], error: s.missing };
      const probe = `.ephyra/repro/${task.trail.short}.sh`;
      const body = `#!/bin/sh\nbun -e '${s.probe}'\n`;
      await exec(runner, handle, ["mkdir", "-p", ".ephyra/repro"]);
      await runner.writeFile(handle, probe, body);
      return { ok: true, artefacts: { [probe]: body }, outputs: { probe }, usage, sessions: [] };
    }
    if (task.step !== "patch") throw new Error(`no script for step ${task.step}`);
    await git("switch", "-q", "-C", "ephyra-patch");
    await runner.writeFile(handle, s.file, s.patches[Math.min(n, s.patches.length) - 1]!);
    await git("add", s.file);
    await git("commit", "-q", "-m", `fix(${area}): attempt ${n}\n\nEphyra-Trail: ${task.trail.id}`);
    return { ok: true, artefacts: {}, outputs: { head: await git("rev-parse", "HEAD") }, usage, sessions: [] };
  }
}

const fixtureDraft: DraftModel = {
  kind: "fake", billedTo: "byok",
  complete: async () => ({
    text: JSON.stringify({ recipient: "owner", question: "What value should apply when the record is missing entirely?",
      reason: "The probe needs the expected value first.", acceptance: "State the value." }),
    engine: "fixture/indep-draft-1", tokens: null, costMicrousd: null,
  }),
};
const people = (): PeopleConnection => ({
  enabled: true, workspaceId: "shop", webhookUrl: null, keyConfigured: false, updatedAt: new Date().toISOString(),
  contacts: [{ id: "owner", alias: "Fixture owner", roles: ["maintainer"], areas: [], did: CONTACT }],
});
const fixtureDecide: DecideBackend = {
  kind: "selfhosted:fixture", alias: "indep-decide", supports: ["noul", "choice", "score"],
  async decide(request: JudgementRequest): Promise<JudgementResponse> {
    const answers: Record<string, JudgementAnswer> = {};
    for (const [key, q] of Object.entries(request.questions)) {
      if (q.type === "noul") answers[key] = { type: "noul", noul: 0.95 };
      else if (q.type === "score") answers[key] = { type: "score", score: 1, probabilities: { "1": 0.95 }, legend: {}, confidence: 0.95 };
      else {
        const offered = Object.keys(q.criteria);
        if (offered.length === 2 && offered.includes("accept") && offered.includes("reject")) {
          answers[key] = { type: "choice", choice: "accept", probabilities: { accept: 0.97, reject: 0.03 }, confidence: 0.97 }; continue;
        }
        const c = offered.includes("auto_fix") ? "auto_fix" : offered.includes("none") ? "none" : offered[0] ?? "none";
        answers[key] = { type: "choice", choice: c, probabilities: { [c]: 0.95 }, confidence: 0.95 };
      }
    }
    return { model: DECIDE_MODEL, answers };
  },
};
const otlp = (type: string, message: string, stack: string) => JSON.stringify({ resourceLogs: [{
  resource: { attributes: [{ key: "service.name", value: { stringValue: "shop" } }] },
  scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, severityNumber: 17, body: { stringValue: `${type}: ${message}` },
    attributes: [
      { key: "exception.type", value: { stringValue: type } }, { key: "exception.message", value: { stringValue: message } },
      { key: "exception.stacktrace", value: { stringValue: `${type}: ${message}\n${stack}` } }] }] }],
}] });

// ───────── boot ─────────
const dir = await mkdtemp(join(tmpdir(), "ephyra-indep-"));
const origin = join(dir, "app");
await mkdir(origin);
await sh(origin, "git", "init", "-q", "-b", "main");
const BROKEN: Record<string, string> = {
  "inventory.js": "exports.qty = (item) => item.stock.qty;\n",
  "billing.js": "exports.net = (gross, pct) => gross / (1 + pct / 100);\n",
  "refunds.js": "exports.refund = (paid, kept) => paid - kept.fee;\n",
  "invoices.js": "exports.number = (n) => n.toString().padStart(6, \"0\");\n",
  "taxes.js": "exports.round = (x) => x.toFixed(2);\n",
  "coupons.js": "exports.off = (price, code) => price - code.value;\n",
  "giftcards.js": "exports.balance = (card) => card.cents / 100;\n",
  "ledger.js": "exports.total = (book) => book.rows.reduce((a, r) => a + r, 0);\n",
};
for (const [f, c] of Object.entries(BROKEN)) await writeFile(join(origin, f), c);
await writeFile(join(origin, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "bun test" } }));
await writeFile(join(origin, "shop.test.js"), [
  "const { test, expect } = require('bun:test');",
  "test('qty', () => expect(require('./inventory.js').qty({ stock: { qty: 3 } })).toBe(3));",
  "test('net', () => expect(require('./billing.js').net(120, 20)).toBe(100));",
  "test('refund', () => expect(require('./refunds.js').refund(100, { fee: 10 })).toBe(90));",
  "test('number', () => expect(require('./invoices.js').number(7)).toBe('000007'));",
  "test('round', () => expect(require('./taxes.js').round(1.234)).toBe('1.23'));",
  "test('off', () => expect(require('./coupons.js').off(10, { value: 3 })).toBe(7));",
  "test('balance', () => expect(require('./giftcards.js').balance({ cents: 250 })).toBe(2.5));",
  "test('total', () => expect(require('./ledger.js').total({ rows: [1, 2] })).toBe(3));", "",
].join("\n"));
await sh(origin, "git", "add", ".");
await sh(origin, "git", "commit", "-q", "-m", "init");
await chmod(origin, 0o755);
const BLOCKING = ["billing", "refunds", "invoices", "taxes", "ledger"];
const autonomy = join(dir, "autonomy.md");
await writeFile(autonomy, [
  "# Autonomy policy", "", "## defaults", "mode: enforce", "checkpoints: A=advisory B=advisory C=advisory", "landing: trail_ref", `watch: ${WATCH_S}s`, "",
  ...Object.keys(SCRIPT).flatMap((area) => [`## area: ${area}`, `paths: ${SCRIPT[area]!.file}`, "risk: low",
    ...(BLOCKING.includes(area) ? ["checkpoints: C=blocking"] : []), `The ${area} code.`, ""]),
].join("\n"));
await writeFile(join(dir, "thresholds.yaml"), `"${DECIDE_MODEL}": {}\n`);

const agent = new Agent();
let server: Composed | null = null;
let http: ReturnType<typeof Bun.serve> | null = null;
let base = ""; let port = 0; let pumping = true; let pumpError: unknown = null;

const dataGit = (...a: string[]) => sh(join(dir, "data"), "git", "--git-dir", "workspace.git", ...a);
type Detail = { trail: Trail; events: TrailEvent[]; artefacts: { path: string; content: string | null }[]; effects?: { cause: string; effect: { key: string } }[] };
const get = async <T>(path: string, who = ME): Promise<T> => {
  const r = await fetch(`${base}${path}`, { headers: H(who) });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return await r.json() as T;
};
const trails = () => get<Trail[]>("/v1/trails");
const detail = (id: string) => get<Detail>(`/v1/trails/${id}`);
const inbox = (who = ME) => get<any[]>("/v1/inbox", who);
const byArea = async (area: string) => (await trails()).filter((t) => t.area === area);
const questionsFor = async (who = ME): Promise<InvestigationQuestion[]> => {
  const r = await fetch(`${base}/v1/questions`, { headers: H(who) }); return r.ok ? await r.json() as InvestigationQuestion[] : [];
};
async function until(pred: () => Promise<boolean>, label: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pumpError) throw new Error(`job loop failed waiting for ${label}: ${String(pumpError)}`); if (await pred()) return; await Bun.sleep(80); }
  const all = await trails();
  const seen = await Promise.all(all.map(async (t) => `${t.area}/${t.short} ${t.state} last=${(await detail(t.id)).events.at(-1)?.type}`));
  throw new Error(`timed out waiting for ${label}: ${seen.join("; ")}`);
}
async function expected(t: Trail, who = ME): Promise<QuestView> {
  const [{ events, artefacts }, items, qs] = await Promise.all([detail(t.id), inbox(who), questionsFor(who)]);
  return questView({ trail: t, events, inbox: items, recovery: parseRecovery(artefacts), questions: qs, viewer: who });
}
const signal = async (area: string, type: string, message: string, who = ME) => {
  const r = await fetch(`${base}/otlp/v1/logs`, { method: "POST", headers: H(who), body: otlp(type, message, `    at fn (${SCRIPT[area]!.file}:1:30)\n    at caller (app.js:3:10)`) });
  ok(r.ok, `signal for ${area} refused: ${r.status}`); return r.status;
};
const trailOf = async (area: string) => { const l = await byArea(area); ok(l.length > 0, `no quest for ${area}`); return l[0]!; };
const stateOf = async (area: string) => (await trailOf(area)).state;
const decisions = (events: readonly TrailEvent[]) => events.filter((e) => e.type === "checkpoint_decided");
const humanDecisions = (events: readonly TrailEvent[]) => decisions(events).filter((e: any) => e.data.decision.by === "human");

const autonomyEnv = {
  EPHYRA_API_TOKEN: TOKEN, EPHYRA_DATA_DIR: join(dir, "data"), EPHYRA_REPO_ID: "shop", EPHYRA_REPO_URL: origin, EPHYRA_WATCH_EVERY_S: "1",
  EPHYRA_AUTONOMY_FILE: autonomy, EPHYRA_THRESHOLDS_FILE: join(dir, "thresholds.yaml"), EPHYRA_CONSOLE_DIR: join(process.cwd(), "dist"),
};
server = await compose(readConfig(autonomyEnv), {
  startJobs: false, agent, decide: fixtureDecide, runner: new LocalRunner(join(dir, "runner"), { trusted: true }),
  questions: {
    did: CONTACT, workspaceId: "shop", publicOrigin: "http://127.0.0.1", model: async () => fixtureDraft,
    box: await SecretBox.fromBase64(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")),
    connection: async () => ({ settings: people() }),
    fetcher: async () => { throw new Error("no network"); },
  },
  landing: async ({ ctx, ledger, probes, runProbe }) => ({
    adapters: [new PlainGitAdapter(ctx.repo.mirrorDir, undefined, ctx.repo.id, ctx.repo.mirrorDir, ledger)],
    watch: {
      prepare: async (trail) => measureWatchBaseline(ctx, trail, (await probes.list(trail)).map((p) => p.id)),
      coverage: async () => ({ source: "offline-OTLP-fixture", observedAt: ctx.clock.now().toISOString(), gaps: [] }),
      deployed: async (_t, receipt) => ({ sha: await sh(ctx.repo.mirrorDir, "git", "rev-parse", receipt.target), observedAt: ctx.clock.now().toISOString(),
        deployedAt: receipt.at, source: "offline-local-ref-fixture" }),
      runProbe: async (id, trail, key) => { const p = (await probes.list(trail)).find((e) => e.id === id); return p ? (await runProbe(p, trail, key)).result : "unavailable"; },
    },
  }),
});
const composed = server;
const serveIt = (p: number) => Bun.serve({ port: p, hostname: "127.0.0.1", fetch: (r) => composed.app.fetch(r) });
http = serveIt(0); port = http.port!; base = `http://127.0.0.1:${port}`;
void (async () => { while (pumping) { try { await composed.jobs.drain(); } catch (e) { pumpError = e; } await Bun.sleep(40); } })();

// ───────── browser helpers ─────────
const browser = await launch();
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {});
async function open(principal: string, size = { width: 1440, height: 900 }, hash = "#/loop", tag = "page") {
  const context = await browser.newContext({ viewport: size, reducedMotion: "reduce" });
  await context.route("**/*", (r) => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
  await context.addInitScript(([k, v]) => sessionStorage.setItem(k!, v!), ["ephyra.connection", JSON.stringify({ token: TOKEN, principal })]);
  const page = await context.newPage();
  const pend = new Map<any, string>(); (page as any).__pend = pend;
  const polls: number[] = []; (page as any).__polls = polls;
  page.on("request", (r) => { if (/\/v1\/trails(\?|$)/.test(r.url())) polls.push(Date.now()); });
  page.on("request", (r) => pend.set(r, `${Date.now()} ${r.method()} ${r.url().replace(base, "")}`));
  page.on("requestfinished", (r) => pend.delete(r)); page.on("requestfailed", (r) => pend.delete(r));
  const lr: string[] = []; (page as any).__lastResp = lr;
  page.on("response", async (r) => { if (/\/v1\/trails(\?|$)/.test(r.url())) { const b = await r.json().catch(() => null); lr.push(`${new Date().toISOString().slice(11,19)} ${r.status()} cc=${r.headers()["cache-control"]} etag=${r.headers()["etag"]} fromCache=${(r as any).fromServiceWorker()} states=${Array.isArray(b) ? b.map((t: any) => t.short + ":" + t.state).join(",") : "?"}`); } });
  page.on("pageerror", (e) => consoleProblems.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") consoleProblems.push(`[${tag}] console.error: ${m.text().slice(0, 200)}`); });
  await page.goto(`${base}/app/${hash}`);
  return { context, page };
}
const txt = async (page: Page, sel: string) => ((await page.locator(sel).first().innerText({ timeout: 300 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
const toast = (page: Page) => txt(page, "[data-toast]");

/** What the page shows against what the server's state computes. Returns problems (empty = agree). */
async function disagreements(page: Page, who: string): Promise<string[]> {
  // The page lists the five most recently finished quests and folds the rest behind "Show all N finished".
  // That is deliberate, so the comparison opens the fold rather than calling a folded quest missing.
  await page.locator('.lp-groups-more[aria-expanded="false"]').click({ timeout: 300 }).catch(() => {});
  const ts = await trails();
  const views = await Promise.all(ts.map((t) => expected(t, who)));
  const problems: string[] = [];
  for (const v of views) {
    const els = page.locator(`[data-quest="${v.short}"]`);
    const n = await els.count();
    if (n === 0) { problems.push(`${v.short} (${v.area}) not on page`); continue; }
    for (let i = 0; i < n; i++) {
      const a = `${await els.nth(i).getAttribute("data-stage")}/${await els.nth(i).getAttribute("data-attention")}`;
      if (a !== `${v.stage.id}/${v.attention}`) problems.push(`${v.short} (${v.area}) page=${a} server=${v.stage.id}/${v.attention} state=${v.state}`);
    }
  }
  const f = fleetView(views);
  const sentence = await txt(page, "[data-loop-fleet]");
  if (sentence !== f.sentence) problems.push(`sentence page="${sentence}" server="${f.sentence}"`);
  for (const g of ["you", "self", "stopped", "finished"] as const) {
    const h = await txt(page, `section[data-group="${g}"] > h2`);
    const shown = h ? Number(h.match(/(\d+)\s*$/)?.[1] ?? NaN) : 0;
    if (shown !== f.groups[g]) problems.push(`group ${g}: heading "${h}" server=${f.groups[g]}`);
  }
  // independent invariants, not via the model
  const strips = await page.locator("[data-needs-you]").count();
  if (strips > 1) problems.push(`${strips} needs-you strips`);
  const items = (await inbox(who)).filter((i) => i.blocking);
  if (items.length === 0 && strips > 0 && f.groups.you === 0) problems.push("strip shown with nothing blocking");
  return problems;
}
async function agree(page: Page, who: string, label: string, ms = 12_000): Promise<string> {
  const end = Date.now() + ms; let p: string[] = [];
  while (Date.now() < end) { p = await disagreements(page, who); if (!p.length) return `${label}: agree`; await Bun.sleep(500); }
  const diag = await page.evaluate(() => {
    const now = performance.now();
    const r = performance.getEntriesByType("resource").filter((e) => e.name.includes("/v1/trails") && !/\/v1\/trails\//.test(e.name));
    return { hidden: document.hidden, vis: document.visibilityState, trailsPolls: r.length, lastPollAgoMs: r.length ? Math.round(now - r[r.length - 1]!.startTime) : null, lastDurMs: r.length ? Math.round(r[r.length - 1]!.duration) : null };
  }).catch((e) => ({ err: String(e) }));
  const pending = [...(((page as any).__pend as Map<any, string>)?.values() ?? [])].map((x) => `${Math.round((Date.now() - Number(x.split(" ")[0])) / 1000)}s ago ${x.split(" ").slice(1).join(" ")}`);
  const lst = await trails(); const dets = await Promise.all(lst.map(async (t) => { const d = await detail(t.id); return `${t.short} list=${t.state}@${t.updatedAt} detail=${d.trail.state}@${d.trail.updatedAt} lastEv=${d.events.at(-1)?.type}@${d.events.at(-1)?.at}`; }));
  console.log("LISTDIAG " + dets.join(" ;; "));
  const lastResp = (page as any).__lastResp as string[] | undefined; console.log("LASTRESP " + JSON.stringify(lastResp?.slice(-4)));
  console.log("PAGETEXT " + JSON.stringify((await page.locator("[data-loop-page]").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 700)));
  await page.screenshot({ path: join(OUT, `disagree-${Date.now()}.png`) }).catch(() => {});
  throw new Error(`${label}: ${p.join(" | ")} PENDING ${JSON.stringify(pending)} POLLS total=${((page as any).__polls ?? []).length} lastAgo=${Math.round((Date.now() - (((page as any).__polls ?? [0]).at(-1) ?? 0)) / 1000)}s DIAG ${JSON.stringify(diag)}`);
}

// background sampler: a disagreement that lasts > 7 s (poll is 2 s) is a failure
let samplerPage: Page | null = null; let samplerOn = true; let samples = 0; const persistent = new Map<string, { since: number; max: number }>();
void (async () => {
  while (samplerOn) {
    await Bun.sleep(1200);
    if (!samplerPage || samplerPaused) continue;
    try {
      const p = await disagreements(samplerPage, ME); samples++;
      const now = Date.now();
      for (const k of [...persistent.keys()]) if (!p.includes(k)) persistent.delete(k);
      for (const m of p) { const e = persistent.get(m) ?? { since: now, max: 0 }; e.max = now - e.since; persistent.set(m, e); if (e.max > 7000) worst.set(m, e.max); }
    } catch { /* page navigating */ }
  }
})();
let samplerPaused = false; const worst = new Map<string, number>();

// ───────── run ─────────
const approveKeyboard = async (page: Page) => {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("a");
  const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-primary") ?? false);
  ok(focused, "pressing a did not focus the primary action");
  await page.keyboard.press("Enter");
};
const ref = (id: string, file: string) => dataGit("show", `refs/heads/ephyra/${id}:${file}`);
const refExists = async (id: string) => (await dataGit("for-each-ref", `refs/heads/ephyra/${id}`)).length > 0;
const done = (s: string) => ["watching", "closed"].includes(s);

let live: { context: BrowserContext; page: Page } | null = null;
try {
  // 7/8: a page opened before anything exists, never reloaded
  live = await open(ME, undefined, "#/loop", "live");
  const lp = live.page;
  await lp.waitForSelector("[data-loop-fleet]", { timeout: 15_000 });
  await lp.evaluate(() => { (window as any).__mark = 4242; });
  samplerPage = lp;
  await check("10c", "empty state", async () => {
    const s = await txt(lp, "[data-loop-fleet]"); await shot(lp, "00-empty");
    ok(/quiet|Nothing/i.test(s), `empty sentence "${s}"`);
    return `empty fleet sentence "${s}"; body note "${await txt(lp, ".lp-board-note")}"`;
  });

  // ── 1: low-risk drives itself
  let inv: Trail | undefined;
  await check("1", "low-risk error drives itself to closed with 0 human decisions; fix on ref", async () => {
    await signal("inventory", "TypeError", "Cannot read properties of undefined (reading 'qty')");
    await until(async () => (await byArea("inventory"))[0]?.state === "closed", "inventory closed", 90_000);
    inv = await trailOf("inventory");
    const { events } = await detail(inv.id);
    ok(humanDecisions(events).length === 0, "a human decision is on record");
    const types = events.map((e) => e.type);
    for (const t of ["triage_completed", "research_completed", "repro_completed", "plan_completed", "patch_completed", "proof_completed", "landing_completed", "watch_started", "watch_completed"])
      ok(types.includes(t as any), `missing ${t}; got ${types.join(",")}`);
    ok((await inbox()).filter((i) => i.blocking).length === 0, "something blocking appeared");
    const f = await ref(inv.id, "inventory.js"); ok(f.includes("item.stock ?"), `ref content: ${f}`);
    await agree(lp, ME, "after inventory");
    return `${inv.short} closed, ${events.length} events, 0 human decisions, ref has "${f.trim()}"`;
  });

  // ── 2 + duplicate (10)
  let bill: Trail | undefined;
  await check("2", "blocking landing: exactly one primary; a then Enter approves; journal records principal", async () => {
    await signal("billing", "RangeError", "net price is NaN");
    await until(async () => (await byArea("billing"))[0]?.state === "ready", "billing ready");
    bill = await trailOf("billing");
    await until(async () => (await inbox()).some((i) => i.trailId === bill!.id && i.blocking), "the checkpoint to reach the inbox", 10_000);
    const item = (await inbox()).find((i) => i.trailId === bill!.id && i.blocking);
    ok(item?.checkpoint === "C", `no blocking C item; inbox=${JSON.stringify(await inbox()).slice(0, 600)}`);
    await lp.waitForSelector(`[data-needs-you="${bill.short}"]`, { timeout: 10_000 });
    const prim = lp.locator("[data-primary]");
    ok(await prim.count() === 1, `${await prim.count()} [data-primary] elements`);
    ok(await prim.first().isVisible(), "primary not visible");
    const label = await txt(lp, "[data-primary]");
    await shot(lp, "02-billing-needs-you");
    await agree(lp, ME, "billing waiting");
    await Bun.sleep(1500);
    ok(await stateOf("billing") === "ready", "moved without approval");
    // duplicate signal while open (check 10)
    const before = (await trails()).length;
    const st = await signal("billing", "RangeError", "net price is NaN");
    await Bun.sleep(4000);
    const after = await trails();
    notes.push(`duplicate identical error while billing quest open: signal HTTP ${st}; quests ${before} -> ${after.length}; billing quests: ${after.filter((t) => t.area === "billing").map((t) => `${t.short}:${t.state}`).join(",")}`);
    await agree(lp, ME, "after duplicate");
    await approveKeyboard(lp);
    await until(async () => done(await stateOf("billing")), "billing lands");
    const { events } = await detail(bill.id);
    const d: any = decisions(events).find((e: any) => e.data.checkpoint === "C" && e.data.decision.by === "human");
    ok(d, "no human C decision in journal");
    ok(d.data.decision.who === ME, `recorded as ${d.data.decision.who}`);
    ok(d.data.decision.verdict === "approve", `verdict ${d.data.decision.verdict}`);
    const f = await ref(bill.id, "billing.js"); ok(f.includes("pct || 0"), `ref: ${f}`);
    const t = await toast(lp);
    return `one [data-primary] "${label}"; approved by ${d.data.decision.who}; landed (${f.trim().slice(0, 50)}); toast "${t}"`;
  });
  await check("10d", "duplicate identical error while a quest is open: coherent", async () => {
    const all = await trails(); const bq = all.filter((t) => t.area === "billing");
    await agree(lp, ME, "after duplicate settled", 15_000);
    return `billing quests=${bq.length} (${bq.map((t) => t.short + ":" + t.state).join(",")}); page agrees with server`;
  });

  // ── 3: send back
  await check("3", "send back with a note -> patching -> back for approval; note on record", async () => {
    await signal("refunds", "TypeError", "Cannot read properties of undefined (reading 'fee')");
    await until(async () => (await byArea("refunds"))[0]?.state === "ready", "refunds ready");
    const t = await trailOf("refunds");
    await lp.waitForSelector(`[data-needs-you="${t.short}"]`, { timeout: 10_000 });
    const note = "Please also floor the refund at zero so it can never go negative.";
    await lp.locator(`[data-needs-you="${t.short}"] button:text-is("Send back")`).click();
    const input = lp.locator(`[data-needs-you="${t.short}"] input`);
    await input.waitFor({ timeout: 3000 });
    ok(await lp.locator("[data-primary]").evaluate((el) => (el as HTMLButtonElement).disabled), "Send back submit not disabled with empty note");
    await input.fill("   ");
    ok(await lp.locator("[data-primary]").evaluate((el) => (el as HTMLButtonElement).disabled), "Send back enabled with blank note");
    await input.fill(note);
    await shot(lp, "03-sendback-form");
    await lp.locator("[data-primary]").click();
    await until(async () => (await detail(t.id)).events.some((e: any) => e.type === "checkpoint_decided" && e.data.decision.verdict === "revise"), "revise recorded");
    const sawPatching = await (async () => { for (let i = 0; i < 100; i++) { const s = await stateOf("refunds"); if (s === "patching") return true; if (s === "ready" && (await detail(t.id)).events.filter((e) => e.type === "patch_completed").length >= 2) return false; await Bun.sleep(50); } return false; })();
    await until(async () => { const d = await detail(t.id); return d.trail.state === "ready" && d.events.filter((e) => e.type === "patch_completed").length >= 2; }, "back at ready after second patch");
    const d = await detail(t.id);
    const dec: any = decisions(d.events).find((e: any) => e.data.decision.verdict === "revise");
    ok(dec.data.decision.note === note, `note on decision: ${dec.data.decision.note}`);
    ok(dec.data.decision.who === ME, `revise recorded as ${dec.data.decision.who}`);
    const inRecovery = JSON.stringify(d.artefacts).includes("floor the refund") || JSON.stringify(d.events).includes("floor the refund");
    ok(agent.turns.includes("refunds:patch:2"), "no second patch turn");
    await lp.waitForSelector(`[data-needs-you="${t.short}"]`, { timeout: 10_000 });
    await agree(lp, ME, "refund back at approval");
    await approveKeyboard(lp);
    await until(async () => done(await stateOf("refunds")), "refunds lands");
    const f = await ref(t.id, "refunds.js"); ok(f.includes("Math.max"), `landed is not the second patch: ${f}`);
    return `revise note recorded under ${dec.data.decision.who} (${inRecovery ? "also in artefacts/events" : "decision only"}); state went patching(seen=${sawPatching}) -> ready; second patch landed after approval`;
  });

  // ── 4: drop
  await check("4", "Drop needs two presses; then quest ends; nothing lands", async () => {
    await signal("invoices", "TypeError", "Cannot read properties of undefined (reading 'toString')");
    await until(async () => (await byArea("invoices"))[0]?.state === "ready", "invoices ready");
    const t = await trailOf("invoices");
    await lp.waitForSelector(`[data-needs-you="${t.short}"]`, { timeout: 10_000 });
    const drop = lp.locator(`[data-needs-you="${t.short}"] button:text-is("Drop")`);
    await drop.click();
    await Bun.sleep(1200);
    ok(await stateOf("invoices") === "ready", "one press already acted");
    const confirm = lp.locator(`[data-needs-you="${t.short}"] [data-confirm-drop]`);
    ok(await confirm.count() === 1, "no explicit confirmation appeared after the first press");
    const t1 = `${await txt(lp, `[data-needs-you="${t.short}"] [data-confirm-drop]`)} / ${await txt(lp, `[data-needs-you="${t.short}"] .lp-needs-warn`)}`;
    ok(/confirm/i.test(t1) && /nothing lands/i.test(t1), `the confirmation does not say what it will do: "${t1}"`);
    await shot(lp, "04-drop-confirm");
    await confirm.click();
    await until(async () => !["ready"].includes(await stateOf("invoices")), "invoices leaves ready");
    await Bun.sleep(1500);
    const s = await stateOf("invoices");
    const d = await detail(t.id);
    const dec: any = decisions(d.events).at(-1);
    ok(dec.data.decision.verdict === "reject" && dec.data.decision.who === ME, `decision ${JSON.stringify(dec.data.decision)}`);
    ok(!(await refExists(t.id)), "a landing ref exists for the dropped quest");
    ok(!d.events.some((e) => e.type === "landing_completed"), "landing_completed on dropped quest");
    await agree(lp, ME, "after drop");
    await shot(lp, "04-after-drop");
    return `after press 1 state=ready, toast "${t1}"; after press 2 state=${s}; no ref; no landing event`;
  });

  // ── 5: stale approval
  await check("5", "stale approval: HTTP first, then stale page button; no false success; recovers", async () => {
    await signal("taxes", "TypeError", "Cannot read properties of null (reading 'toFixed')");
    await until(async () => (await byArea("taxes"))[0]?.state === "ready", "taxes ready");
    const t = await trailOf("taxes");
    await lp.waitForSelector(`[data-needs-you="${t.short}"]`, { timeout: 10_000 });
    samplerPaused = true;
    await lp.route("**/v1/**", (r) => (r.request().method() === "GET" ? r.abort() : r.continue()));
    const item = (await inbox()).find((i) => i.trailId === t.id && i.blocking)!;
    const r = await fetch(`${base}/v1/trails/${t.id}/decide`, { method: "POST", headers: { ...H("someone-else"), "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ checkpoint: "C", verdict: "approve", bound: item.bound }) });
    ok(r.ok, `HTTP approve answered ${r.status}`);
    await lp.locator("[data-primary]").click();
    await Bun.sleep(2500);
    const t1 = await toast(lp);
    const banner = await txt(lp, "[data-stale]");
    await shot(lp, "05-stale-click");
    await lp.unroute("**/v1/**");
    ok(!/^Approved/.test(t1) && !/moves on by itself/.test(t1), `page claims success: "${t1}"`);
    await until(async () => done(await stateOf("taxes")), "taxes lands");
    await agree(lp, ME, "after stale recovery", 15_000);
    await lp.waitForSelector("[data-stale]", { state: "detached", timeout: 10_000 });
    const gone = await lp.locator(`[data-needs-you="${t.short}"]`).count();
    ok(gone === 0, "strip still there after recovery");
    samplerPaused = false;
    return `HTTP approve ${r.status} by someone-else; stale click toast "${t1}"; banner while cut off "${banner}"; page recovered, strip gone`;
  });

  // ── 6: ask a person
  await check("6", "needs-a-fact quest: 403 for non-contact, no form; contact sees it, empty/long, answers, lands", async () => {
    await signal("coupons", "RangeError", "price went negative: coupon value unknown");
    let q: InvestigationQuestion | undefined;
    await until(async () => {
      const t = (await byArea("coupons"))[0]; if (!t || t.state !== "parked") return false;
      q = (await questionsFor()).find((x) => x.trailId === t.id && x.status === "awaiting_answer"); return q?.delivery.status === "sent";
    }, "coupons asks");
    const t = await trailOf("coupons");
    const url = `${base}/v1/questions/${t.id}/${q!.id}/answer`;
    const r403 = await fetch(url, { method: "POST", headers: H(ME), body: JSON.stringify({ text: "anything" }) });
    ok(r403.status === 403, `non-contact answer -> ${r403.status}`);
    ok((await stateOf("coupons")) === "parked", "refused answer moved the quest");
    // operator page
    await lp.locator(`[data-quest="${t.short}"] button`).first().click();
    await Bun.sleep(800);
    const form = await lp.locator("[data-answer]").count();
    const strip = await lp.locator(`[data-needs-you="${t.short}"]`).count();
    await shot(lp, "06-asking-operator");
    ok(form === 0, "operator sees an answer form"); ok(strip === 0, "operator sees a needs-you strip for the question");
    const att = await lp.locator(`[data-quest="${t.short}"]`).first().getAttribute("data-attention");
    await agree(lp, ME, "operator view of asking");
    // contact page
    const c = await open(CONTACT, undefined, "#/loop", "contact");
    const cp = c.page;
    await cp.waitForSelector(`[data-needs-you="${t.short}"]`, { timeout: 12_000 });
    await shot(cp, "06-contact-needs-you");
    ok(await cp.locator("[data-primary]").count() === 1, "contact: primary count != 1");
    await agree(cp, CONTACT, "contact view");
    await cp.locator("[data-primary]").click();
    const box = cp.locator("[data-answer] textarea");
    await box.waitFor({ timeout: 4000 });
    ok(await box.evaluate((e) => e === document.activeElement), "textarea not focused");
    const send = cp.locator('[data-answer] button[type="submit"]');
    ok(await send.isDisabled(), "send enabled with empty answer");
    await box.fill("   \n  "); ok(await send.isDisabled(), "send enabled with whitespace");
    const emptyHttp = await fetch(url, { method: "POST", headers: H(CONTACT), body: JSON.stringify({ text: "" }) });
    const wsHttp = await fetch(url, { method: "POST", headers: H(CONTACT), body: JSON.stringify({ text: "   " }) });
    ok((await stateOf("coupons")) === "parked", `empty HTTP answer moved the quest (empty ${emptyHttp.status}, ws ${wsHttp.status})`);
    ok(emptyHttp.status >= 400 && emptyHttp.status < 500, `empty answer -> ${emptyHttp.status}`);
    await box.fill(""); await box.click(); await cp.keyboard.insertText("x".repeat(4200));
    const len = await box.evaluate((e) => (e as HTMLTextAreaElement).value.length);
    await shot(cp, "06-contact-long");
    await box.fill("");
    const ANSWER = "A missing coupon takes nothing off: the value is 0.";
    await box.fill(ANSWER);
    await cp.locator('[data-answer] button[type="submit"]').click();
    await cp.waitForFunction(() => (document.querySelector("[data-toast]")?.textContent ?? "").length > 0, null, { timeout: 10_000 });
    const t1 = await toast(cp);
    await until(async () => done(await stateOf("coupons")), "coupons lands after answer", 90_000);
    const sq: any = await get(`/v1/questions/${t.id}/${q!.id}`);
    ok(sq.status === "answered" && sq.answer.text === ANSWER, `question ${sq.status} / ${sq.answer?.text}`);
    const { events } = await detail(t.id);
    ok(events.some((e) => e.type === "resumed"), "no resumed event");
    ok(humanDecisions(events).length === 0, "a checkpoint decision by a human");
    const f = await ref(t.id, "coupons.js"); ok(f.includes("code ? code.value : 0"), `ref ${f}`);
    await Bun.sleep(300);
    await cp.waitForSelector(`[data-needs-you="${t.short}"]`, { state: "detached", timeout: 10_000 });
    await shot(cp, "06-contact-answered");
    await c.context.close();
    return `non-contact HTTP 403, operator saw attention=${att}, form=${form}; contact: empty HTTP ${emptyHttp.status}/ws ${wsHttp.status}, 4200 typed chars -> textarea holds ${len}; toast "${t1}"; resumed and landed`;
  });
  await check("6b", "gift card question: HTTP edge answers (empty, huge, wrong type)", async () => {
    await signal("giftcards", "TypeError", "balance is undefined");
    let q: InvestigationQuestion | undefined;
    await until(async () => {
      const t = (await byArea("giftcards"))[0]; if (!t || t.state !== "parked") return false;
      q = (await questionsFor()).find((x) => x.trailId === t.id && x.status === "awaiting_answer"); return q?.delivery.status === "sent";
    }, "giftcards asks");
    const t = await trailOf("giftcards");
    const url = `${base}/v1/questions/${t.id}/${q!.id}/answer`;
    const post = async (body: unknown, raw = false) => { const r = await fetch(url, { method: "POST", headers: { ...H(CONTACT), "Idempotency-Key": crypto.randomUUID() }, body: raw ? (body as string) : JSON.stringify(body) }); return r.status; };
    const out: string[] = [];
    out.push(`number text=${await post({ text: 5 })}`, `no body field=${await post({})}`, `bad json=${await post("{nope", true)}`);
    out.push(`5000 chars=${await post({ text: "y".repeat(5000) })}`);
    const st5 = (await get<InvestigationQuestion>(`/v1/questions/${t.id}/${q!.id}`)).status;
    out.push(`state after 5000=${st5}`);
    if (st5 === "awaiting_answer") out.push(`1MB=${await post({ text: "z".repeat(1_000_000) })}`);
    const stNow = (await get<InvestigationQuestion>(`/v1/questions/${t.id}/${q!.id}`)).status;
    if (stNow === "awaiting_answer") await post({ text: "An unknown gift card is worth 0." });
    await until(async () => done(await stateOf("giftcards")), "giftcards lands", 90_000);
    notes.push(`giftcards HTTP edge answers: ${out.join(", ")}`);
    const bad = out.filter((o) => /=5\d\d$/.test(o));
    ok(bad.length === 0, `server errors: ${bad.join(", ")}`);
    return out.join("; ");
  });

  // ── 10: held quest (reload, direct link, unknown id, server outage, phone)
  const hold = agent.hold("ledger:patch:1");
  let ledger: Trail | undefined;
  let held = false;
  await signal("ledger", "TypeError", "Cannot read properties of null (reading 'rows')");
  await Promise.race([hold.reached.then(() => { held = true; }), Bun.sleep(60_000)]);
  if (!held) throw new Error("ledger patch never reached the agent");
  ledger = await trailOf("ledger");
  await lp.waitForSelector(`[data-quest="${ledger.short}"]`, { timeout: 10_000 });
  await agree(lp, ME, "while ledger held");

  await check("7", "live page changed with no reload (marker survives) through the whole run", async () => {
    // evaluated at the end too; here assert it shows ledger mid-quest
    const m = await lp.evaluate(() => (window as any).__mark);
    ok(m === 4242, "marker lost");
    const a = await lp.locator(`[data-quest="${ledger!.short}"]`).first().getAttribute("data-attention");
    return `marker intact mid-run; ledger row attention=${a} state=${ledger!.state}`;
  });
  await check("10a", "reload mid-quest", async () => {
    const x = await open(ME, undefined, "#/loop", "reload");
    await x.page.waitForSelector(`[data-quest="${ledger!.short}"]`, { timeout: 12_000 });
    await x.page.reload(); await x.page.waitForSelector(`[data-quest="${ledger!.short}"]`, { timeout: 12_000 });
    const r = await agree(x.page, ME, "after reload"); await shot(x.page, "10a-reload"); await x.context.close(); return r;
  });
  await check("10b", "direct link #/loop/<short> opens that quest", async () => {
    const x = await open(ME, undefined, `#/loop/${ledger!.short}`, "direct");
    await x.page.waitForSelector(`[data-detail="${ledger!.short}"]`, { timeout: 12_000 });
    // pick a different quest to be sure it's not just the default focus
    const other = (await trails()).find((t) => t.area === "inventory")!;
    const y = await open(ME, undefined, `#/loop/${other.short}`, "direct2");
    await y.page.waitForSelector(`[data-detail="${other.short}"]`, { timeout: 12_000 });
    const sel = await y.page.locator("[data-detail]").first().getAttribute("data-detail");
    await shot(x.page, "10b-direct"); await x.context.close(); await y.context.close();
    return `direct link shows detail for ${ledger!.short} and for closed ${other.short} (detail=${sel})`;
  });
  await check("10e", "unknown quest id in address", async () => {
    const x = await open(ME, undefined, "#/loop/zzzzzzzz", "unknown");
    await x.page.waitForSelector("[data-loop-fleet]", { timeout: 12_000 });
    await Bun.sleep(1500);
    const det = await x.page.locator("[data-detail]").first().getAttribute("data-detail").catch(() => null);
    const body = (await x.page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160);
    await shot(x.page, "10e-unknown");
    ok(await x.page.locator("[data-loop-page]").count() === 1, "loop page not rendered");
    const said = await txt(x.page, "[data-unknown-quest]");
    await x.context.close();
    ok(/zzzzzzzz/.test(said), `the page shows ${det} without saying the address named a quest it does not have (body: ${body})`);
    return `page renders; detail shown = ${det}; it says: "${said}"`;
  });
  await check("10f", "server outage: page says it lost contact, then recovers", async () => {
    samplerPaused = true;
    http!.stop(true);
    await lp.waitForSelector("[data-stale]", { timeout: 15_000 });
    const msg = await txt(lp, "[data-stale]"); await shot(lp, "10f-lost-contact");
    const stillShows = await lp.locator(`[data-quest="${ledger!.short}"]`).count();
    http = serveIt(port);
    await lp.waitForSelector("[data-stale]", { state: "detached", timeout: 15_000 });
    samplerPaused = false;
    await agree(lp, ME, "after outage");
    return `banner "${msg}"; board kept ${stillShows} rows meanwhile; banner cleared after restart`;
  });
  await check("10g-pre", "phone viewport while quest is only working (no scroll sideways)", async () => {
    const x = await open(ME, { width: 390, height: 844 }, "#/loop", "phone-held");
    await x.page.waitForSelector("[data-loop-fleet]", { timeout: 12_000 });
    await Bun.sleep(1000);
    const sw = await x.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    await shot(x.page, "10g-phone-working"); await x.context.close();
    ok(sw.sw <= sw.iw, `scrollWidth ${sw.sw} > ${sw.iw}`);
    return `scrollWidth ${sw.sw} <= ${sw.iw}`;
  });
  hold.release();
  await until(async () => (await stateOf("ledger")) === "ready", "ledger ready");
  const phone = await open(ME, { width: 390, height: 844 }, "#/loop", "phone");
  await check("10g", "390x844: no horizontal scroll, primary action in first viewport", async () => {
    const pp = phone.page;
    await pp.waitForSelector(`[data-needs-you="${ledger!.short}"]`, { timeout: 12_000 });
    await Bun.sleep(600);
    const m = await pp.evaluate(() => {
      const el = document.querySelector("[data-primary]")!; const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, sw: document.documentElement.scrollWidth, iw: window.innerWidth, bsw: document.body.scrollWidth, sy: window.scrollY };
    });
    await shot(pp, "10g-phone-needs-you");
    ok(m.sw <= m.iw && m.bsw <= m.iw, `horizontal overflow sw=${m.sw} bsw=${m.bsw} iw=${m.iw}`);
    ok(m.top >= 0 && m.bottom <= 844 && m.left >= 0 && m.right <= 390, `primary at ${JSON.stringify(m)}`);
    return `primary box y=${m.top.toFixed(0)}..${m.bottom.toFixed(0)} x=${m.left.toFixed(0)}..${m.right.toFixed(0)}, scrollWidth ${m.sw}/${m.iw}`;
  });

  // ── 9: under the hood (on closed billing quest and ready ledger)
  await check("9", "under the hood: events count, unique effect keys, Esc returns focus", async () => {
    const target = bill!;
    await lp.locator(`[data-quest="${target.short}"] button`).first().click();
    await lp.waitForSelector(`[data-detail="${target.short}"]`);
    await lp.locator("[data-open-hood]").click();
    await lp.waitForSelector("[data-hood-events]", { timeout: 5000 });
    const sv = await detail(target.id);
    const n = await lp.locator("[data-hood-events] > li").count();
    ok(n === sv.events.length, `events tab ${n} vs journal ${sv.events.length}`);
    await shot(lp, "09-hood-events");
    await lp.getByRole("tab", { name: /effects/i }).click().catch(async () => { await lp.locator('button:text-is("Effects")').click(); });
    await lp.waitForSelector("[data-hood-effects], .lp-hood-empty", { timeout: 4000 });
    const keys = await lp.locator("[data-idempotency-key]").allInnerTexts();
    ok(keys.length > 0, "effects tab lists no effects");
    ok(new Set(keys).size === keys.length, `duplicate effect keys: ${keys.length} listed, ${new Set(keys).size} unique`);
    if (sv.effects) ok(sv.effects.length === keys.length, `server effects ${sv.effects.length} vs tab ${keys.length}`);
    await shot(lp, "09-hood-effects");
    await lp.keyboard.press("Escape");
    await Bun.sleep(300);
    ok(await lp.locator("[data-hood-effects], [data-hood-events]").count() === 0, "hood still open after Esc");
    const f = await lp.evaluate(() => ({ open: document.activeElement?.hasAttribute("data-open-hood"), tag: document.activeElement?.tagName, txt: (document.activeElement as HTMLElement)?.innerText?.slice(0, 20) }));
    ok(f.open, `focus is on ${f.tag} "${f.txt}", not the opener`);
    // reopen with the key
    // Reopened, the hood shows the tab it was left on (effects), so wait for the hood itself.
    await lp.keyboard.press("i"); await lp.waitForSelector("[data-inspector]", { timeout: 3000 });
    await lp.keyboard.press("Escape"); await Bun.sleep(200);
    const f2 = await lp.evaluate(() => document.activeElement?.hasAttribute("data-open-hood"));
    return `${n} events = journal ${sv.events.length}; ${keys.length} effects, ${new Set(keys).size} unique keys; Esc closed, focus on opener (key-opened too: ${f2})`;
  });

  // finish ledger from the phone
  await check("10h", "approve from the phone viewport", async () => {
    await phone.page.locator("[data-primary]").click();
    await until(async () => done(await stateOf("ledger")), "ledger lands");
    await Bun.sleep(1000);
    const d = await detail(ledger!.id);
    const dec: any = decisions(d.events).find((e: any) => e.data.decision.by === "human");
    ok(dec?.data.decision.who === ME, "no human decision under ME");
    return `phone click approved by ${dec.data.decision.who}; toast "${await toast(phone.page)}"`;
  });
  await phone.context.close();

  // ── wrap up: everything closes; live page final state
  await check("8", "agreement at the end after every quest settled", async () => {
    await until(async () => (await trails()).every((t) => t.state === "closed" || t.state === "rejected" || t.state === "dropped" || !["watching", "ready", "patching", "parked"].includes(t.state)), "all settle", 60_000);
    const states = (await trails()).map((t) => `${t.area}:${t.state}`).join(" ");
    await shot(lp, "08-final");
    const r = await agree(lp, ME, "final");
    const sentence = await txt(lp, "[data-loop-fleet]");
    return `${r}; sentence "${sentence}"; states ${states}; sampler took ${samples} samples; persistent (>7s) disagreements: ${worst.size ? [...worst.entries()].map(([k, v]) => `${k} (${v}ms)`).join("; ") : "none"}`;
  });
  await check("7b", "live page never reloaded across the run", async () => {
    const m = await lp.evaluate(() => (window as any).__mark);
    ok(m === 4242, `marker is ${m}`);
    const n = await lp.locator("[data-quest]").count();
    return `marker still 4242 after ${rows.length} checks; ${n} [data-quest] nodes on the page`;
  });
  if (worst.size) rows.push({ id: "8b", name: "sampler: persistent disagreement", status: "FAIL", detail: [...worst.entries()].map(([k, v]) => `${k} (${v}ms)`).join("; ") });
  else rows.push({ id: "8b", name: "sampler over run", status: "PASS", detail: `${samples} samples, none disagreed for >7s` });
} catch (e) {
  rows.push({ id: "driver", name: "driver aborted", status: "FAIL", detail: e instanceof Error ? e.stack ?? e.message : String(e) });
  console.log("DRIVER ABORTED", e);
} finally {
  samplerOn = false; agent.releaseAll(); pumping = false;
  await Bun.sleep(100);
  await browser.close().catch(() => {});
  http?.stop(true);
  await composed.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

const out = [
  ...rows.map((r) => `${r.status.padEnd(14)} ${r.id.padEnd(8)} ${r.name}\n               ${r.detail}`),
  "", "NOTES:", ...notes.map((n) => `- ${n}`),
  "", `PAGE CONSOLE PROBLEMS (${consoleProblems.length}):`, ...[...new Set(consoleProblems)].slice(0, 20).map((p) => `- ${p}`),
].join("\n");
console.log("\n=================== RESULT ===================\n" + out);
await Bun.write(join(OUT, "result.txt"), out);
process.exit(rows.every((r) => r.status === "PASS") ? 0 : 1);
