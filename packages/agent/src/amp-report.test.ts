import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import type { AgentTask, OperationLedger, OperationRecord, Runner, RunnerHandle } from "@ephyra/core";
import { AmpReportInbox, validateAmpReport, type AmpReportRequest } from "./amp-report";
import { AmpAgent } from "./amp";
import { installEphyraPlugin } from "../../../.amp/plugins/ephyra";

const THREAD = "T-01a1b539-866f-77a3-833f-b417d7707bbd";
const TRAIL = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://ephyra.example";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

class Ledger implements OperationLedger {
  records = new Map<string, OperationRecord>();
  async begin(key: string, planDigest: string) {
    const record = this.records.get(key);
    if (record) { if (record.planDigest !== planDigest) throw new Error("operation key reused"); return { fresh: false as const, record }; }
    this.records.set(key, { key, planDigest, status: "pending", at: new Date().toISOString() });
    return { fresh: true as const };
  }
  async complete(key: string, result: unknown) { const record = this.records.get(key)!; this.records.set(key, { ...record, status: "done", result }); }
  async markAmbiguous(key: string, note: string) {
    const record = this.records.get(key)!;
    this.records.set(key, { ...record, status: "reconciliation_required", result: note });
  }
  async get(key: string) { return this.records.get(key) ?? null; }
}

async function command(argv: string[], cwd: string): Promise<Uint8Array> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const [out, error, exit] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (exit) throw new Error(error);
  return new Uint8Array(out);
}
const text = (value: Uint8Array) => new TextDecoder().decode(value).trim();

function task(step: "repro" | "patch", base: string): AgentTask {
  return { step, budget: { tokens: 10000, wallclockS: 60 }, context: {}, untrusted: {}, trail: {
    schema: 1, id: TRAIL, short: "T-111111", repo: "test", title: "A recorded error", rev: 2, state: step === "patch" ? "patching" : "reproducing",
    signals: [], area: "app", risk: "low", route: "auto_fix", severity: 1, base: { ref: "refs/heads/main", sha: base },
    checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 }, mirrors: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    budget: { tokensUsed: 0, tokensMax: 10000, wallclockMaxS: 300, spendMicrousdUsed: 0, spendMicrousdMax: 1000000 },
  } };
}

function pluginApi() {
  const events = new Map<string, (event: any, ctx?: any) => any>();
  const tools = new Map<string, (input: Record<string, unknown>, ctx: any) => Promise<string>>();
  return { events, tools, api: {
    on(event: string, handler: (event: any, ctx?: any) => any) { events.set(event, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool.execute); },
    helpers: { shellCommandFromToolCall: (event: any) => event.tool === "shell_command" ? { command: event.input.command } : null,
      filesModifiedByToolCall: () => null, filePathFromURI: (uri: any) => uri.toString() },
  } };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-amp-report-"));
  directories.push(directory);
  const remote = join(directory, "remote"), receiver = join(directory, "receiver");
  await mkdir(remote);
  await command(["git", "init", "-q", "-b", "main"], remote);
  await writeFile(join(remote, "value.js"), "exports.value = 0;\n");
  await command(["git", "add", "value.js"], remote);
  await command(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial"], remote);
  const base = text(await command(["git", "rev-parse", "HEAD"], remote));
  await command(["git", "clone", "-q", remote, receiver], directory);
  const ledger = new Ledger();
  let allowed = true;
  const inbox = new AmpReportInbox({ origin: ORIGIN, ledger,
    verify: async (token) => { if (token !== "fixture-short-lived-token") throw new Error("invalid signature"); return { threadId: THREAD }; },
    authorize: async () => allowed });
  const plugin = pluginApi();
  installEphyraPlugin(plugin.api, { origin: ORIGIN, cwd: remote,
    run: async (argv, cwd) => argv[0] === "amp" ? new TextEncoder().encode("fixture-short-lived-token") : command(argv, cwd),
    fetcher: (async (url, options) => {
      expect(options!.redirect).toBe("error");
      const token = (options!.headers as Record<string, string>).Authorization!.slice(7);
      const receipt = await inbox.accept(new URL(String(url)).pathname.split("/").at(-1)!, token, JSON.parse(String(options!.body)));
      return Response.json(receipt);
    }) as typeof fetch,
  });
  const handle: RunnerHandle = { id: "report-fixture", runner: "fixture", workdir: receiver, trailId: TRAIL, attempt: 1,
    leaseExpiresAt: new Date(Date.now() + 120000).toISOString() };
  let shouldReport = true;
  const runner: Runner = {
    name: "fixture", capabilities: { shell: true, browser: false, checkpoint: "none", network: ["none"] },
    async *exec(_handle, argv) {
      if (argv[0] === "amp") {
        const prompt = argv.at(-1)!;
        await plugin.events.get("agent.start")!({ thread: { id: THREAD }, message: prompt });
        if (shouldReport) {
          if (prompt.includes('"step":"repro"')) {
            await mkdir(join(remote, ".ephyra/repro"), { recursive: true });
            await writeFile(join(remote, ".ephyra/repro/value.sh"), "#!/bin/sh\nnode -e 'process.exit(require(\"./value.js\").value === 1 ? 0 : 1)'\n");
          } else {
            await writeFile(join(remote, "value.js"), "exports.value = 1;\n");
            await plugin.tools.get("ephyra_commit")!({ paths: ["value.js"] }, { thread: { id: THREAD } });
          }
          await plugin.events.get("tool.call")!({ thread: { id: THREAD }, tool: "shell_command", toolUseID: "actual-call",
            input: { command: "git push origin main" } });
          await plugin.tools.get("ephyra_report")!({}, { thread: { id: THREAD } });
        }
        yield { stream: "stdout", chunk: JSON.stringify({ type: "result", session_id: THREAD, subtype: "success", is_error: false,
          result: "I succeeded", usage: { input_tokens: 30, output_tokens: 20 } }) + "\n" };
        yield { exit: 0, durationMs: 1, timedOut: false };
      } else {
        const out = await command(argv, receiver);
        yield { stream: "stdout", chunk: new TextDecoder().decode(out) };
        yield { exit: 0, durationMs: 1, timedOut: false };
      }
    },
    async writeFile(_handle, path, content) {
      await mkdir(dirname(join(receiver, path)), { recursive: true });
      await writeFile(join(receiver, path), content);
    },
    async readFile(_handle, path) { return new Uint8Array(await readFile(join(receiver, path))); },
    async allocate() { throw new Error("unused"); }, async restore() { throw new Error("unused"); }, async checkpoint() { throw new Error("unused"); },
    async exportArtifacts() { return []; }, async destroy() { return { destroyed: true, at: new Date().toISOString() }; },
  };
  let thread: string | null = null;
  const agent = new AmpAgent({ executor: { kind: "orb", project: "fixture" }, reports: inbox,
    threads: { get: async () => thread, set: async (_id, value) => { thread = value; } } });
  return { base, directory, remote, receiver, ledger, inbox, runner, handle, plugin, agent,
    revoke() { allowed = false; }, skipReport() { shouldReport = false; } };
}

test("actual plugin repro bytes and authenticated task binding reach the receiving runner", async () => {
  const f = await fixture();
  const policies: unknown[] = [], usages: unknown[] = [];
  const result = await f.agent.run(task("repro", f.base), f.runner, f.handle, {
    onEvent: (event) => { policies.push(event); }, onUsage: (usage) => { usages.push(usage); },
  });
  expect(result.outputs.probe).toBe(".ephyra/repro/value.sh");
  expect(await readFile(join(f.receiver, result.outputs.probe!), "utf8")).toBe(result.artefacts[result.outputs.probe!]!);
  expect(policies).toContainEqual({ type: "policy", policy: { decision: "reject", rule: "ephyra-repository-tools",
    reason: "Use repository edit tools and ephyra_commit; arbitrary shell execution needs a separate host-granted tool." },
    tool: { callId: "actual-call", name: "shell_command" } });
  expect(usages).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("fixture-short-lived-token");
});

test("actual remote plugin commits and Git bundle transfer preserve exact head, ancestry and trail trailers", async () => {
  const f = await fixture();
  const result = await f.agent.run(task("patch", f.base), f.runner, f.handle);
  expect(result.ok).toBe(true);
  expect(result.outputs.head).toBe(text(await command(["git", "rev-parse", "HEAD"], f.remote)));
  expect(text(await command(["git", "rev-parse", "HEAD"], f.receiver))).toBe(result.outputs.head!);
  expect(await readFile(join(f.receiver, "value.js"), "utf8")).toBe("exports.value = 1;\n");
  expect(JSON.stringify(result)).not.toContain("fixture-short-lived-token");
});

test("a success transcript cannot replace an absent authenticated report; actual usage remains recorded", async () => {
  const f = await fixture(); f.skipReport();
  const usage: unknown[] = [];
  await expect(f.agent.run(task("patch", f.base), f.runner, f.handle, {
    onUsage: (value) => { usage.push(value); },
  })).rejects.toThrow("plugin result unavailable");
  expect(usage).toHaveLength(1);
});

test("authentication, revocation, immutable submission and continued-thread binding are enforced", async () => {
  const f = await fixture();
  const request = await f.inbox.open(task("repro", f.base), f.handle, THREAD);
  const report = { schema: 1 as const, request, threadId: THREAD, policies: [], probe: { path: ".ephyra/repro/x.sh", content: "exit 1\n" } };
  await expect(f.inbox.accept(request.nonce, "not-a-token", report)).rejects.toThrow("invalid signature");
  await expect(f.inbox.accept(request.nonce, "fixture-short-lived-token", {
    ...report, threadId: "T-22222222-2222-4222-8222-222222222222",
  })).rejects.toThrow("thread binding");
  const first = await f.inbox.accept(request.nonce, "fixture-short-lived-token", report);
  expect(await f.inbox.accept(request.nonce, "fixture-short-lived-token", report)).toEqual(first);
  await expect(f.inbox.accept(request.nonce, "fixture-short-lived-token", {
    ...report, probe: { ...report.probe, content: "different" },
  })).rejects.toThrow("key reused");
  f.revoke();
  await expect(f.inbox.collect(request, THREAD)).rejects.toThrow("revoked");
});

test("report data cannot substitute arbitrary revisions, endpoints or artifact paths", () => {
  const request: AmpReportRequest = { schema: 1, nonce: "a".repeat(64), trailId: TRAIL, revision: 2, step: "repro", base: "b".repeat(40),
    expectedThread: THREAD, expiresAt: new Date(Date.now() + 60000).toISOString(), url: `${ORIGIN}/amp/reports/${"a".repeat(64)}` };
  fc.assert(fc.property(fc.string().filter((value) => !/^\.ephyra\/repro\/[\w.-]+\.sh$/.test(value)), (path) => {
    expect(() => validateAmpReport({ schema: 1, request, threadId: THREAD, policies: [], probe: { path, content: "exit 1" } }, request, THREAD)).toThrow();
  }), { numRuns: 40 });
  expect(() => validateAmpReport({ schema: 1, request: { ...request, revision: 3 }, threadId: THREAD, policies: [],
    probe: { path: ".ephyra/repro/x.sh", content: "exit 1" } }, request, THREAD)).toThrow("binding");
});

test("an uncertain report submission is never automatically resent", async () => {
  const f = await fixture(), api = pluginApi();
  const request = await f.inbox.open(task("repro", f.base), f.handle, THREAD);
  await mkdir(join(f.remote, ".ephyra/repro"), { recursive: true });
  await writeFile(join(f.remote, ".ephyra/repro/x.sh"), "exit 1\n");
  let sends = 0;
  installEphyraPlugin(api.api, { origin: ORIGIN, cwd: f.remote,
    run: async (argv, cwd) => argv[0] === "amp" ? new TextEncoder().encode("fixture-short-lived-token") : command(argv, cwd),
    fetcher: (async () => { sends++; throw new Error("lost response"); }) as unknown as typeof fetch });
  await api.events.get("agent.start")!({ thread: { id: THREAD }, message: `<ephyra_report_request>${JSON.stringify(request)}</ephyra_report_request>` });
  await expect(api.tools.get("ephyra_report")!({}, { thread: { id: THREAD } })).rejects.toThrow("lost response");
  await expect(api.tools.get("ephyra_report")!({}, { thread: { id: THREAD } })).rejects.toThrow("will not be resent");
  expect(sends).toBe(1);
});
