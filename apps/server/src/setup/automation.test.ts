import { afterEach, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAutonomy, checkpointMode } from "@ephyra/policy";
import { AutomaticSetup, bootstrapArtifacts, setupGit, type SetupCapability } from "./automation.ts";
import type { JobRunner, Jobs } from "../wiring/context.ts";
import type { SetupRun } from "@ephyra/core";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-auto-test-"));
  directories.push(directory);
  const proc = Bun.spawn(["git", "init", "--bare", "-q", directory], { stdout: "ignore", stderr: "ignore" });
  expect(await proc.exited).toBe(0);
  const git = setupGit(directory);
  const rows: string[] = [];
  for (const [path, content] of Object.entries({ "package.json": JSON.stringify({ scripts: { test: "bun test", build: "bun build src.ts" } }), ...extra })) {
    const oid = (await git(["hash-object", "-w", "--stdin"], { input: content })).trim();
    rows.push(`100644 blob ${oid}\t${path}\n`);
  }
  const tree = (await git(["mktree"], { input: rows.join("") })).trim();
  const head = (await git(["commit-tree", tree, "-m", "fixture"])).trim();
  await git(["update-ref", "refs/heads/trunk", head]);
  const runners = new Map<string, JobRunner>();
  const queued: { kind: string; key: string; payload: unknown }[] = [];
  const jobs: Jobs = {
    register: (kind, runner) => { runners.set(kind, runner); },
    enqueue: async (kind, key, payload) => { if (!queued.some((job) => job.key === key)) queued.push({ kind, key, payload }); },
  };
  let capabilities: SetupCapability[] = [];
  const activated: SetupRun[] = [];
  const options = {
    git, jobs, repo: { id: "ws-test", url: "https://git.example/team/project.git", baseRef: "refs/heads/trunk",
      mirrorDir: directory, remote: "origin", forge: "plain" as const },
    capabilities: async () => capabilities,
    activate: async (run: SetupRun) => { activated.push(structuredClone(run)); },
  };
  const service = new AutomaticSetup(options);
  const drain = async () => {
    while (queued.length) {
      const job = queued.shift()!;
      await runners.get(job.kind)!(job.payload, { key: job.key, attempt: 1 });
    }
  };
  return { git, head, service, options, activated, queued, drain, setCapabilities: (value: SetupCapability[]) => { capabilities = value; } };
}

test("automatic setup writes actual policy documents, inspectable stages and a pinned source commit", async () => {
  const f = await fixture();
  const run = await f.service.start("autonomous", "setup:test-001");
  expect(run.status).toBe("queued");
  await f.drain();
  const saved = (await f.service.current())!;
  expect(saved.status).toBe("ready");
  expect(saved.repository.head).toBe(f.head);
  expect(saved.steps.every((step) => step.status === "complete")).toBe(true);
  expect(saved.artifacts.map((a) => a.path)).toContain("autonomy.md");
  const policy = await f.git(["show", `${saved.policyRef}:autonomy.md`]);
  expect(checkpointMode(parseAutonomy(policy), parseAutonomy(policy).areas[0]!, "C")).toBe("advisory");
  expect(await f.git(["show", `${saved.policyRef}:ephyra/verification.json`])).toContain('"not_run"');
  expect(f.activated).toHaveLength(1);
  expect((await f.git(["rev-parse", "refs/heads/trunk"])).trim()).toBe(f.head);
});

test("same operation is idempotent, mode conflicts fail and concurrent starts cannot overlap", async () => {
  const f = await fixture();
  const run = await f.service.start("autonomous", "setup:test-002");
  expect((await f.service.start("autonomous", "setup:test-002")).id).toBe(run.id);
  expect(f.queued).toHaveLength(1);
  await expect(f.service.start("supervised", "setup:test-002")).rejects.toThrow("another setup mode");
  await expect(f.service.start("autonomous", "setup:test-other")).rejects.toThrow("already running");
  await f.drain();
  expect((await f.service.current("setup:test-002"))!.operationKey).toBe("setup:test-002");
  expect(await f.service.current("setup:never-started")).toBeNull();
});

test("missing capabilities create precise operator blockers without activating", async () => {
  const f = await fixture();
  f.setCapabilities([{ id: "runner", available: false, summary: "No sandbox", action: "Provision workspace runner" }]);
  await f.service.start("autonomous", "setup:test-003");
  await f.drain();
  expect(await f.service.current()).toMatchObject({ status: "blocked", blockers: [{ id: "runner", owner: "operator" }] });
  expect(f.activated).toHaveLength(0);
});

test("a restart reconstructs queued setup from git and does not require the original queue", async () => {
  const f = await fixture();
  await f.service.start("autonomous", "setup:test-004");
  f.queued.splice(0);
  const restarted = new AutomaticSetup(f.options);
  await restarted.restore();
  expect(f.queued).toHaveLength(1);
  await f.drain();
  expect((await restarted.current())!.status).toBe("ready");
});

test("restart rechecks readiness and refuses previously available but now missing capabilities", async () => {
  const f = await fixture();
  await f.service.start("autonomous", "setup:test-005");
  await f.drain();
  f.setCapabilities([{ id: "runner", available: false, summary: "Runner removed", action: "Reconnect runner" }]);
  const restarted = new AutomaticSetup(f.options);
  await restarted.restore();
  expect((await restarted.current())!.status).toBe("blocked");
  expect(f.activated).toHaveLength(1);
});

test("existing policy is retained and setup cannot silently expand permissions", async () => {
  const policy = "## defaults\nmode: shadow\n## area: app\npaths: **\nrisk: high\n";
  const f = await fixture({ "autonomy.md": policy });
  await f.service.start("autonomous", "setup:test-006");
  await f.drain();
  expect((await f.service.current())!.artifacts.find((a) => a.path === "autonomy.md")!.content).toBe(policy);
});

test("a moved repository blocks activation instead of activating an obsolete snapshot", async () => {
  const f = await fixture();
  await f.service.start("autonomous", "setup:test-007");
  const tree = (await f.git(["rev-parse", `${f.head}^{tree}`])).trim();
  const changed = (await f.git(["commit-tree", tree, "-p", f.head, "-m", "changed"])).trim();
  await f.git(["update-ref", "refs/heads/trunk", changed]);
  await f.drain();
  expect((await f.service.current())!.blockers.some((b) => b.id === "base_changed")).toBe(true);
  expect(f.activated).toHaveLength(0);
});

test("untrusted filenames and scripts cannot inject policy grants or fake test outcomes", () => {
  fc.assert(fc.property(fc.array(fc.string(), { maxLength: 30 }), fc.string(), (files, command) => {
    const artifacts = bootstrapArtifacts(files, { scripts: { test: command } }, "autonomous");
    const policy = artifacts.find((a) => a.path === "autonomy.md")!.content;
    expect(parseAutonomy(policy).areas.map((a) => a.name)).toEqual(["application", "automation-control"]);
    const proof = JSON.parse(artifacts.find((a) => a.path === "ephyra/verification.json")!.content);
    expect(proof.status).toBe("not_run");
    expect(artifacts.every((a) => /^[a-f0-9]{64}$/.test(a.digest))).toBe(true);
  }));
});
