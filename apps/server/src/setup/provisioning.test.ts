import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ExecOutput, Runner, ServiceProfile, SetupRun } from "@ephyra/core";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { provisionSetup, type SetupProvisioningOptions } from "./provisioning.ts";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const head = "a".repeat(40);
const profile: ServiceProfile = { name: "setup", digest: "ignored", network: "egress", credentials: [], readOnlyProd: true,
  limits: { cpu: 1, memoryMb: 1000, diskMb: 0, timeoutS: 60 } };
const verification = (commands = [
  { name: "test", command: "test-runner" }, { name: "typecheck", command: "tsc --noEmit" }, { name: "build", command: "build-tool" },
]) => {
  const content = JSON.stringify({ schema: 1, status: "not_run", commands, required: ["repro_before", "repro_after", "tests", "intent_probes"] });
  return { path: "ephyra/verification.json", content, digest: sha(content) };
};
function run(): SetupRun {
  return { id: "1".repeat(32), mode: "autonomous", status: "running", repository: { url: "https://example.test/private/repo", branch: "main", head },
    startedAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", steps: [], artifacts: [verification()], blockers: [] };
}
const receipt = (result: Awaited<ReturnType<typeof provisionSetup>>) => JSON.parse(result.artifacts.find(a => a.path === "ephyra/provisioning.json")!.content);
function fixture(manager = "npm", version = "10.0.0", lockfile = "package-lock.json") {
  const manifest = { packageManager: `${manager}@${version}`, scripts: { test: "test-runner", typecheck: "tsc --noEmit", build: "build-tool" } };
  const files = new Map<string, Uint8Array>([
    ["package.json", new TextEncoder().encode(JSON.stringify(manifest))],
    [lockfile, new TextEncoder().encode("offline-lock-fixture")],
  ]);
  let allocations = 0, destructions = 0;
  const allocationsSeen: Parameters<Runner["allocate"]>[0][] = [];
  const commands: string[][] = [], environments: Record<string, string>[] = [];
  const handler = { exec: async function* (argv: string[]): AsyncIterable<ExecOutput> {
    if (argv[0] === "git") yield { stream: "stdout", chunk: `${head}\n` };
    else if (argv[1] === "--version") yield { stream: "stdout", chunk: `${version}\n` };
    else yield { stream: "stdout", chunk: "fixture execution\n" };
    yield { exit: 0, durationMs: 13, timedOut: false };
  } };
  const runner: Runner = {
    name: "offline-fixture", capabilities: { checkpoint: "none", network: ["egress"], shell: true, browser: false },
    async allocate(req) {
      allocations++; allocationsSeen.push(req);
      return { id: `handle-${allocations}`, runner: this.name, workdir: "/workspace", trailId: req.trail.id, attempt: req.attempt,
        leaseExpiresAt: new Date(Date.now() + 600000).toISOString() };
    },
    async *exec(_handle, argv, opts) { commands.push(argv); environments.push(opts.env ?? {}); yield* handler.exec(argv); },
    async readFile(_handle, path) { return files.get(path) ?? null; },
    async writeFile() {}, async checkpoint() { throw new Error("unused"); },
    async restore() { throw new Error("unused"); }, async exportArtifacts() { return []; },
    async destroy() { destructions++; return { destroyed: true, at: "2026-11-08T01:00:00Z" }; },
  };
  const ledger = new MemoryOperationLedger();
  const options: SetupProvisioningOptions = { runner, profile, ledger, repoUrl: "/host/account-mirror.git", scope: "did:plc:owner/repo" };
  return { runner, ledger, options, commands, files, handler, manifest, allocationsSeen, environments, counts: () => ({ allocations, destructions }) };
}

test("setup runs the exact base, installation and every recorded check, then cleans up", async () => {
  const f = fixture(); const setup = run(); const result = await provisionSetup(f.options, setup);
  expect(result.verification).toBe(true); expect(result.provisioned).toBe(true);
  expect(f.commands).toEqual([["git", "rev-parse", "HEAD"], ["npm", "--version"], ["npm", "ci", "--no-audit", "--no-fund"],
    ["npm", "run", "test"], ["npm", "run", "typecheck"], ["npm", "run", "build"], ["git", "rev-parse", "HEAD"]]);
  expect(f.allocationsSeen[0]!.commit).toBe(head); expect(f.allocationsSeen[0]!.operationKey).toContain("setup:provision:");
  expect(f.allocationsSeen[0]!.operationKey).toEndWith(":allocate");
  const record = receipt(result);
  expect(record).toMatchObject({ schema: 1, head, status: "passed", verification: true, provisioned: true, cleanup: { status: "destroyed" } });
  expect(record.receipts).toHaveLength(7);
  expect(record.receipts.every((r: { exit: number; durationMs: number }) => r.exit === 0 && r.durationMs === 13)).toBe(true);
  expect(record.toolchain).toMatchObject({ manager: "npm", version: "10.0.0", lockfile: "package-lock.json" });
  expect(f.counts()).toEqual({ allocations: 1, destructions: 1 });
  expect(setup.artifacts[0]!.content).toContain("not_run");
  for (const artifact of result.artifacts) expect(artifact.digest).toBe(sha(artifact.content));
});

test("completed setup replay returns exact evidence without another paid operation", async () => {
  const f = fixture(); const setup = run(); const first = await provisionSetup(f.options, setup);
  const second = await provisionSetup(f.options, setup);
  expect(second).toEqual(first); expect(f.counts()).toEqual({ allocations: 1, destructions: 1 }); expect(f.commands).toHaveLength(7);
  expect(await provisionSetup(f.options, { ...setup, artifacts: first.artifacts })).toEqual(first);
  expect(f.counts()).toEqual({ allocations: 1, destructions: 1 });
});

test("baseline failure is recorded, all other checks still run, and no pass is claimed", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.handler.exec = async function* (argv) {
    if (argv[2] === "test") { yield { stream: "stderr", chunk: "existing baseline failure" }; yield { exit: 2, durationMs: 17, timedOut: false }; }
    else yield* original(argv);
  };
  const result = await provisionSetup(f.options, run()); const record = receipt(result);
  expect(result.verification).toBe(false); expect(result.provisioned).toBe(true); expect(record.status).toBe("failed");
  expect(record.receipts.find((r: { name: string }) => r.name === "test")).toMatchObject({
    status: "failed", exit: 2, durationMs: 17, stderr: "existing baseline failure",
  });
  expect(f.commands).toContainEqual(["npm", "run", "build"]); expect(f.counts().destructions).toBe(1);
});

test("timed out install prevents baseline checks and retains exact timeout exit", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.handler.exec = async function* (argv) {
    if (argv[1] === "ci") yield { exit: -1, durationMs: 60000, timedOut: true };
    else yield* original(argv);
  };
  const result = await provisionSetup(f.options, run());
  expect(result.verification).toBe(false); expect(result.provisioned).toBe(false);
  expect(receipt(result).receipts[2]).toMatchObject({ status: "timed_out", exit: -1, durationMs: 60000, timedOut: true });
  expect(f.commands).toHaveLength(3); expect(f.counts().destructions).toBe(1);
});

test("ambiguous command is recorded with no invented exit and is never repeated", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.handler.exec = async function* (argv) {
    if (argv[1] === "ci") { yield { stream: "stdout", chunk: "partial" }; throw new Error("secret upstream diagnostic"); }
    yield* original(argv);
  };
  const setup = run(); const first = await provisionSetup(f.options, setup); const second = await provisionSetup(f.options, setup);
  expect(receipt(first).status).toBe("reconciliation_required");
  expect(receipt(first).receipts[2]).toMatchObject({ status: "unknown", exit: null, durationMs: null, timedOut: null, stdout: "partial" });
  expect(JSON.stringify(first)).not.toContain("secret upstream diagnostic"); expect(second).toEqual(first);
  expect(f.counts()).toEqual({ allocations: 1, destructions: 1 }); expect(f.commands).toHaveLength(3);
});

test("ambiguous allocate and ambiguous cleanup cannot report provisioned or trigger a new allocation", async () => {
  const f = fixture(); let allocations = 0;
  f.runner.allocate = async () => { allocations++; throw new Error("lost create result"); };
  const setup = run(); const first = await provisionSetup(f.options, setup); await provisionSetup(f.options, setup);
  expect(first.provisioned).toBe(false); expect(receipt(first).status).toBe("reconciliation_required"); expect(allocations).toBe(1);
  const g = fixture(); let destroys = 0;
  g.runner.destroy = async () => { destroys++; throw new Error("lost teardown result"); };
  const result = await provisionSetup(g.options, setup); await provisionSetup(g.options, setup);
  expect(result.verification).toBe(false); expect(result.provisioned).toBe(false);
  expect(receipt(result).cleanup.status).toBe("reconciliation_required"); expect(destroys).toBe(1);
});

test("empty, lint-only, duplicate and mismatched plans cannot pass or run arbitrary scripts", async () => {
  for (const candidates of [[], [{ name: "lint", command: "lint" }], [{ name: "test", command: "" }],
    [{ name: "test", command: "a" }, { name: "test", command: "b" }]]) {
    const f = fixture(); const setup = run(); setup.artifacts = [verification(candidates)];
    const result = await provisionSetup(f.options, setup);
    expect(result.verification).toBe(false); expect(receipt(result).status).toBe("unavailable"); expect(f.counts().allocations).toBe(0);
  }
  const f = fixture(); const setup = run(); setup.artifacts = [verification([{ name: "test", command: "unrecorded-command" }])];
  const result = await provisionSetup(f.options, setup);
  expect(result.verification).toBe(false); expect(f.commands).toHaveLength(1); expect(f.counts().destructions).toBe(1);
});

test("package manager and lockfile must be supported and actual version must match", async () => {
  const f = fixture(); f.files.delete("package-lock.json");
  expect(receipt(await provisionSetup(f.options, run())).status).toBe("unavailable"); expect(f.commands).toHaveLength(1);
  const g = fixture(); g.files.set("package.json", new TextEncoder().encode(JSON.stringify({ ...g.manifest, packageManager: "npm@11.0.0" })));
  expect(receipt(await provisionSetup(g.options, run())).status).toBe("unavailable"); expect(g.commands).toHaveLength(2);
  const h = fixture(); h.files.delete("package.json");
  expect(receipt(await provisionSetup(h.options, run())).status).toBe("unavailable");
});

test("lockfile install flags match npm, pnpm, bun, modern yarn and classic yarn", async () => {
  for (const [manager, version, lockfile, install] of [
    ["pnpm", "10.1.0", "pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
    ["bun", "1.4.4", "bun.lock", ["bun", "install", "--frozen-lockfile"]],
    ["yarn", "4.1.0", "yarn.lock", ["yarn", "install", "--immutable"]],
    ["yarn", "1.22.0", "yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
  ] as const) {
    const f = fixture(manager, version, lockfile); const result = await provisionSetup(f.options, run());
    expect(result.verification).toBe(true); expect(f.commands[2]).toEqual([...install]);
  }
});

test("postinstall script mutation is detected before executing changed verification", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.handler.exec = async function* (argv) {
    yield* original(argv);
    if (argv[1] === "ci") f.files.set("package.json", new TextEncoder().encode(JSON.stringify({ ...f.manifest, scripts: { test: "changed" } })));
  };
  const result = await provisionSetup(f.options, run()); expect(result.verification).toBe(false);
  expect(receipt(result).status).toBe("unavailable"); expect(f.commands).toHaveLength(3); expect(f.counts().destructions).toBe(1);
});

test("wrong or changed checkout cannot be baseline evidence for the requested commit", async () => {
  const f = fixture();
  f.handler.exec = async function* () { yield { stream: "stdout", chunk: "b".repeat(40) }; yield { exit: 0, durationMs: 1, timedOut: false }; };
  const result = await provisionSetup(f.options, run());
  expect(result.verification).toBe(false); expect(f.commands).toHaveLength(1); expect(f.counts().destructions).toBe(1);
});

test("split secrets are redacted and JSON receipts remain parseable", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.options.secrets = ["account-private-secret"];
  f.handler.exec = async function* (argv) {
    if (argv[1] === "ci") {
      yield { stream: "stdout", chunk: "password=foo\naccount-private-" };
      yield { stream: "stdout", chunk: "secret\n" }; yield { exit: 0, durationMs: 1, timedOut: false };
    } else yield* original(argv);
  };
  const result = await provisionSetup(f.options, run());
  expect(result.verification).toBe(true); expect(JSON.stringify(result)).not.toContain("account-private-secret");
  expect(receipt(result).receipts[2].stdout).toBe("password=[REDACTED]\n[REDACTED]\n");
  expect(f.environments.every(env => !JSON.stringify(env).includes("account-private-secret"))).toBe(true);
});

test("output overflow omits unsafe fragments and cannot pass checks", async () => {
  const f = fixture(); const original = f.handler.exec;
  f.handler.exec = async function* (argv) {
    if (argv[2] === "test") { yield { stream: "stdout", chunk: "x".repeat(128001) }; yield { exit: 0, durationMs: 1, timedOut: false }; }
    else yield* original(argv);
  };
  const result = await provisionSetup(f.options, run()); expect(result.verification).toBe(false);
  expect(receipt(result).receipts[3]).toMatchObject({ status: "output_limit", outputTruncated: true, stdout: "", exit: 0 });
});

test("a concurrent replay does not destroy an active setup or allocate a replacement", async () => {
  const f = fixture(); const original = f.runner.allocate; let release: (() => void) | undefined;
  f.runner.allocate = async req => { const h = await original.call(f.runner, req); await new Promise<void>(resolve => { release = resolve; }); return h; };
  const setup = run(); const pending = provisionSetup(f.options, setup);
  while (!release) await Bun.sleep(1);
  const replay = await provisionSetup(f.options, setup);
  expect(replay.verification).toBe(false); expect(receipt(replay).status).toBe("reconciliation_required");
  expect(f.counts()).toEqual({ allocations: 1, destructions: 0 });
  release(); expect((await pending).verification).toBe(true);
});

test("different setup run and owner scope receive different stable allocation identities", async () => {
  const f = fixture(); const first = run(); await provisionSetup(f.options, first);
  const second = { ...run(), id: "2".repeat(32) }; await provisionSetup(f.options, second);
  await provisionSetup({ ...f.options, scope: "did:plc:other/repo" }, first);
  expect(new Set(f.allocationsSeen.map(req => req.operationKey)).size).toBe(3);
  expect(new Set(f.allocationsSeen.map(req => req.trail.id)).size).toBe(3);
  await expect(provisionSetup(f.options, { ...first, repository: { ...first.repository, head: "c".repeat(40) } })).rejects.toThrow("operation key reused");
});
