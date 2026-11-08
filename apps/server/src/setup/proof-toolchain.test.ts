import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ReconciliationRequired, Unverified, type ExecOutput, type Runner, type RunnerHandle, type SetupRun } from "@ephyra/core";
import { MemoryOperationLedger } from "../orchestrator/effects.ts";
import { proofToolchain } from "./proof-toolchain.ts";

const base = "a".repeat(40), head = "b".repeat(40);
const baseCwd = ".ephyra-proof-aaaaaaaa-0", headCwd = ".ephyra-proof-aaaaaaaa-1";
const encoder = new TextEncoder();
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const artifact = (path: string, value: unknown) => { const content = JSON.stringify(value); return { path, content, digest: sha(content) }; };
function fixture(manager = "npm", version = "10.0.0", lockfile = "package-lock.json") {
  const manifest = { packageManager: `${manager}@${version}`, scripts: { test: "node --test --test-reporter=tap" }, dependencies: { example: "1.0.0" } };
  const manifestBytes = encoder.encode(JSON.stringify(manifest)), lockBytes = encoder.encode("original-lock");
  const files = new Map<string, Uint8Array>();
  for (const cwd of [baseCwd, headCwd]) {
    files.set(`${cwd}/package.json`, manifestBytes); files.set(`${cwd}/${lockfile}`, lockBytes);
  }
  const setup: SetupRun = {
    id: "setup-fixture", mode: "autonomous", status: "ready", repository: { url: "https://example.test/repo", branch: "main", head: base },
    startedAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", steps: [], blockers: [], artifacts: [
      artifact("ephyra/provisioning.json", { schema: 1, status: "passed", verification: true, provisioned: true, head: base,
        toolchain: { manager, version, lockfile, manifestDigest: sha(manifestBytes), lockDigest: sha(lockBytes) },
        receipts: [{ phase: "verification", name: "test", status: "passed", exit: 0, timedOut: false, outputTruncated: false }] }),
      artifact("ephyra/verification.json", { schema: 1, commands: [{ name: "test", command: manifest.scripts.test }] }),
    ],
  };
  const commands: Array<{ argv: string[]; cwd?: string; deadlineMs: number }> = [];
  const observed = { execute: async function* (argv: string[], cwd?: string): AsyncIterable<ExecOutput> {
    if (argv[0] === "git") yield { stream: "stdout", chunk: `${cwd?.endsWith("-0") ? base : head}\n` };
    else if (argv[1] === "--version") yield { stream: "stdout", chunk: `${version}\n` };
    else yield { stream: "stdout", chunk: "dependencies installed in fixture\n" };
    yield { exit: 0, durationMs: 12, timedOut: false };
  } };
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const runner: Runner = {
    name: "fixture", capabilities: { shell: true, browser: false, checkpoint: "none", network: ["egress"] },
    allocate: unused, destroy: unused, restore: unused, checkpoint: unused, exportArtifacts: unused, writeFile: unused,
    async readFile(_handle, path) { return files.get(path) ?? null; },
    async *exec(_handle, argv, opts) { commands.push({ argv, cwd: opts.cwd, deadlineMs: opts.deadlineMs }); yield* observed.execute(argv, opts.cwd); },
  };
  const handle = { id: "handle-fixture", runner: "fixture", workdir: "/workspace" } as RunnerHandle;
  const options = { runner, handle, setup, base, head, ledger: new MemoryOperationLedger() };
  return { options, commands, files, observed, manifest, manifestBytes, lockBytes, prepare: () => proofToolchain(options) };
}

test("each proof revision verifies identity, installs locked dependencies and uses the recorded test manager", async () => {
  const f = fixture(); const prepare = f.prepare();
  const before = await prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 });
  const after = await prepare({ cwd: headCwd, commit: head, remainingMs: 30000 });
  expect(before.testCommand).toEqual(["npm", "run", "test"]); expect(after.testCommand).toEqual(before.testCommand);
  expect(f.commands.map(call => call.argv)).toEqual([
    ["git", "rev-parse", "HEAD"], ["npm", "--version"], ["npm", "ci", "--no-audit", "--no-fund"],
    ["git", "rev-parse", "HEAD"], ["npm", "--version"], ["npm", "ci", "--no-audit", "--no-fund"],
  ]);
  expect(f.commands.slice(0, 3).every(call => call.cwd === baseCwd)).toBe(true);
  expect(f.commands.slice(3).every(call => call.cwd === headCwd && call.deadlineMs <= 30000)).toBe(true);
  expect(JSON.parse(before.log!).commands[2]).toMatchObject({ exit: 0, durationMs: 12, timedOut: false, complete: true });
});

test("preparation replay does not reinstall the same directory and cannot skip a new directory", async () => {
  const f = fixture(); const prepare = f.prepare();
  const result = await prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 });
  expect(await prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 })).toEqual(result); expect(f.commands).toHaveLength(3);
  const freshCwd = ".ephyra-proof-bbbbbbbb-0";
  f.files.set(`${freshCwd}/package.json`, f.manifestBytes); f.files.set(`${freshCwd}/package-lock.json`, f.lockBytes);
  await prepare({ cwd: freshCwd, commit: base, remainingMs: 50000 }); expect(f.commands).toHaveLength(6);
});

test("base hashes are pinned while head dependency and lockfile changes are installed", async () => {
  const f = fixture();
  f.files.set(`${headCwd}/package.json`, encoder.encode(JSON.stringify({ ...f.manifest, dependencies: { example: "2.0.0" } })));
  f.files.set(`${headCwd}/package-lock.json`, encoder.encode("new-lock"));
  const prepared = await f.prepare()({ cwd: headCwd, commit: head, remainingMs: 50000 });
  expect(JSON.parse(prepared.log!).lockDigest).toBe(sha("new-lock"));
  f.files.set(`${baseCwd}/package-lock.json`, encoder.encode("changed-base-lock"));
  await expect(f.prepare()({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(Unverified);
  expect(f.commands).toHaveLength(3);
});

test("head manager/version or selected test-script changes require a new baseline", async () => {
  for (const change of [ { packageManager: "npm@11.0.0" }, { scripts: { test: "echo pretend success" } } ]) {
    const f = fixture(); f.files.set(`${headCwd}/package.json`, encoder.encode(JSON.stringify({ ...f.manifest, ...change })));
    await expect(f.prepare()({ cwd: headCwd, commit: head, remainingMs: 50000 })).rejects.toBeInstanceOf(Unverified);
    expect(f.commands).toHaveLength(0);
  }
});

test("missing or tampered baseline and an unbaselined test choice are rejected before commands", () => {
  const f = fixture(); f.options.setup.artifacts[0]!.digest = "bad";
  expect(() => f.prepare()).toThrow(Unverified); expect(f.commands).toHaveLength(0);
  const g = fixture(); g.options.setup.repository.head = head;
  expect(() => g.prepare()).toThrow(Unverified);
  const h = fixture(); h.options.setup.artifacts[1] = artifact("ephyra/verification.json", {
    schema: 1, commands: [{ name: "test:unit", command: "unit" }, { name: "test:integration", command: "integration" }],
  });
  expect(() => h.prepare()).toThrow(Unverified);
});

test("unavailable version and failed install remain failed on replay without redispatch", async () => {
  for (const phase of ["version", "install"]) {
    const f = fixture(); const original = f.observed.execute;
    f.observed.execute = async function* (argv, cwd) {
      if ((phase === "version" && argv[1] === "--version") || (phase === "install" && argv[1] === "ci")) {
        yield { exit: 127, durationMs: 3, timedOut: false };
      } else yield* original(argv, cwd);
    };
    const prepare = f.prepare();
    await expect(prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(Unverified);
    const count = f.commands.length;
    await expect(prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(Unverified);
    expect(f.commands).toHaveLength(count);
  }
});

test("an unknown install result cannot be retried through preparation replay", async () => {
  const f = fixture(); const original = f.observed.execute;
  f.observed.execute = async function* (argv, cwd) {
    if (argv[1] === "ci") { yield { stream: "stdout", chunk: "partial installation" }; throw new Error("private upstream error"); }
    yield* original(argv, cwd);
  };
  const prepare = f.prepare();
  await expect(prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(ReconciliationRequired);
  await expect(prepare({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(f.commands).toHaveLength(3);
});

test("postinstall mutation is rejected and all install variants use lockfile enforcement", async () => {
  const f = fixture(); const original = f.observed.execute;
  f.observed.execute = async function* (argv, cwd) {
    yield* original(argv, cwd);
    if (argv[1] === "ci") f.files.set(`${cwd}/package-lock.json`, encoder.encode("mutated"));
  };
  await expect(f.prepare()({ cwd: baseCwd, commit: base, remainingMs: 50000 })).rejects.toBeInstanceOf(Unverified);
  for (const [manager, version, lockfile, flag] of [
    ["pnpm", "10.0.0", "pnpm-lock.yaml", "--frozen-lockfile"], ["bun", "1.4.4", "bun.lock", "--frozen-lockfile"],
    ["yarn", "4.0.0", "yarn.lock", "--immutable"], ["yarn", "1.22.0", "yarn.lock", "--frozen-lockfile"],
  ]) {
    const g = fixture(manager, version, lockfile);
    await g.prepare()({ cwd: baseCwd, commit: base, remainingMs: 50000 });
    expect(g.commands[2]!.argv).toEqual([manager!, "install", flag!]);
  }
});

test("invalid worktree, commit and expired deadline are rejected without executing", async () => {
  const f = fixture(); const prepare = f.prepare();
  for (const input of [ { cwd: "../escape", commit: base, remainingMs: 5000 },
    { cwd: baseCwd, commit: "c".repeat(40), remainingMs: 5000 }, { cwd: baseCwd, commit: base, remainingMs: 0 } ]) {
    await expect(prepare(input)).rejects.toBeInstanceOf(Unverified);
  }
  expect(f.commands).toHaveLength(0);
});
