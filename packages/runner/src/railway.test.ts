import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReconciliationRequired, Unverified, type ServiceProfile, type Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { LeaseExpired } from "./local.ts";
import {
  FileRailwayLeaseStore, MemoryRailwayLeaseStore, MemoryRailwayOperationLedger, RailwaySandboxRunner,
  UnsupportedRailwayConstraint, UnsupportedRailwayNetwork, type RailwaySandboxClient, type RailwayRunnerOptions,
  type RailwayRepositoryBundle,
} from "./railway.ts";
import { railwayPath, railwayQuote } from "./railway-support.ts";

const commit = "a".repeat(40);
const profile: ServiceProfile = { name: "p", digest: "ignored", network: "egress", readOnlyProd: true, credentials: [],
  limits: { cpu: 1, memoryMb: 128, diskMb: 0, timeoutS: 30 } };
const trail = { id: "t", rev: 1 } as Trail;
const request = { trail, attempt: 1, repoUrl: "/host/private/mirror.git", commit, profile };
const bundle = async () => ({ bytes: new TextEncoder().encode("offline bundle fixture"), ref: "refs/ephyra/checkout" });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "ephyra-railway-")); directories.push(dir); return dir; }
function fixture(options: RailwayRunnerOptions = {}) {
  let creates = 0, checkpoints = 0, destroys = 0, execs = 0;
  const networks: string[] = [];
  const files = new Map<string, Uint8Array>();
  const status = new Map<string, "RUNNING" | "DESTROYED">();
  const client: RailwaySandboxClient = {
    scope: "environment-A",
    async create(req) {
      const id = `remote-${++creates}`; networks.push(req.network); status.set(id, "RUNNING");
      await req.onCreated(id); return id;
    },
    async *exec(_id, command) {
      execs++;
      if (command.includes("rev-parse")) yield { stream: "stdout", chunk: `${commit}\n` };
      yield { exit: 0, durationMs: 1, timedOut: false };
    },
    async writeFile(id, path, content) {
      files.set(`${id}:${railwayPath(path)}`, typeof content === "string" ? new TextEncoder().encode(content) : content.slice());
    },
    async readFile(id, path) { return files.get(`${id}:${railwayPath(path)}`)?.slice() ?? null; },
    async checkpoint() { checkpoints++; return "snapshot"; },
    async restore(_snapshot, req) {
      const id = `remote-${++creates}`; networks.push(req.network); status.set(id, "RUNNING"); await req.onCreated(id); return id;
    },
    async destroy(id) { destroys++; status.set(id, "DESTROYED"); },
    async status(id) { return status.get(id) ?? "DESTROYED"; },
  };
  const ledger = options.ledger ?? new MemoryRailwayOperationLedger();
  const leaseStore = options.leaseStore ?? new MemoryRailwayLeaseStore();
  const opts = { scope: "did:plc:owner/workspace", repositoryBundle: bundle, ...options, ledger, leaseStore };
  const runner = new RailwaySandboxRunner(new ArtifactStore("/unused"), client, opts);
  return { runner, client, ledger, leaseStore, opts, files, networks,
    counts: () => ({ creates, checkpoints, destroys, execs }) };
}

describe("Railway durable lifecycle", () => {
  test("preserves validated shallow boundaries without credentials or extra Git commands", async () => {
    const f = fixture({ repositoryBundle: async () => ({ ...await bundle(), shallow: [commit] }) });
    const handle = await f.runner.allocate(request);
    expect(new TextDecoder().decode(f.files.get("remote-1:/workspace/.git/shallow"))).toBe(`${commit}\n`);
    expect(f.counts().execs).toBe(5);
    await f.runner.destroy(handle);
  });
  test("rejects malformed, duplicate, mismatched and unbounded shallow metadata before uploading files", async () => {
    for (const shallow of [null, commit, ["../shallow"], [commit + "\n"], ["b".repeat(64)], [commit, commit], Array(4097).fill(commit)]) {
      const f = fixture({ repositoryBundle: async () => ({ ...await bundle(), shallow }) as RailwayRepositoryBundle });
      await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
      expect(f.files.size).toBe(0); expect(f.counts().execs).toBe(0);
    }
  });
  test("requires explicit configuration and bundle transport before creating", async () => {
    expect(() => new RailwaySandboxRunner(new ArtifactStore("/unused"))).toThrow(Unverified);
    const f = fixture({ repositoryBundle: undefined });
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(Unverified);
    expect(f.counts().creates).toBe(0);
  });
  test("maps supported networks and refuses unenforceable constraints before allocation", async () => {
    const f = fixture();
    const h = await f.runner.allocate(request);
    expect(await f.runner.checkpoint(h)).toEqual({ snapshotId: "snapshot", kind: "disk" });
    const restored = await f.runner.restore("snapshot", { trail, attempt: 2, profile: { ...profile, network: "private" } });
    expect(f.networks).toEqual(["ISOLATED", "PRIVATE"]);
    for (const network of ["none", "egress_allowlist"] as const) {
      await expect(f.runner.allocate({ ...request, profile: { ...profile, network } })).rejects.toBeInstanceOf(UnsupportedRailwayNetwork);
    }
    await expect(f.runner.allocate({ ...request, profile: { ...profile, limits: { ...profile.limits, diskMb: 100 } } }))
      .rejects.toBeInstanceOf(UnsupportedRailwayConstraint);
    await expect(f.runner.allocate({ ...request, profile: { ...profile, credentials: ["production-db"] } }))
      .rejects.toBeInstanceOf(UnsupportedRailwayConstraint);
    expect(f.counts().creates).toBe(2);
    await f.runner.destroy(h); await f.runner.destroy(restored);
  });
  test("allocation and destroy receipts survive process recreation without extending lease", async () => {
    const f = fixture(); const first = await f.runner.allocate(request);
    const restarted = new RailwaySandboxRunner(new ArtifactStore("/unused"), f.client, f.opts);
    expect(await restarted.allocate(request)).toEqual(first);
    expect(f.counts().creates).toBe(1); expect(f.counts().execs).toBe(5);
    const receipt = await restarted.destroy(structuredClone(first));
    expect(await f.runner.destroy(first)).toEqual(receipt); expect(f.counts().destroys).toBe(1);
    await expect(restarted.allocate(request)).rejects.toThrow("destroyed");
  });
  test("changed commit cannot reuse the same operation", async () => {
    const f = fixture(); await f.runner.allocate(request);
    await expect(f.runner.allocate({ ...request, commit: "b".repeat(40) })).rejects.toThrow("plan changed");
    expect(f.counts().creates).toBe(1);
  });
  test("owner scope and handle fields cannot be substituted", async () => {
    const f = fixture(); const h = await f.runner.allocate(request);
    const other = new RailwaySandboxRunner(new ArtifactStore("/unused"), f.client, { ...f.opts, scope: "did:plc:other/workspace" });
    await expect(other.readFile(h, "file")).rejects.toThrow("unknown Railway handle");
    await expect(other.restore("snapshot", { trail, attempt: 2, profile })).rejects.toThrow("unknown Railway checkpoint");
    await expect(f.runner.readFile({ ...h, leaseExpiresAt: "2099-01-01T00:00:00Z" }, "file")).rejects.toThrow("unknown Railway handle");
    const second = await other.allocate(request);
    expect(second.id).not.toBe(h.id); expect(f.counts().creates).toBe(2);
  });
  test("unobserved create failure never creates a second sandbox", async () => {
    const f = fixture(); let calls = 0;
    f.client.create = async () => { calls++; throw new Error("token must not appear"); };
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(calls).toBe(1);
  });
  test("observed create with uncertain readiness is reconciled by status", async () => {
    const f = fixture(); let calls = 0;
    f.client.create = async req => { calls++; await req.onCreated("known-resource"); throw new Error("readiness transport failed"); };
    f.client.status = async () => "RUNNING";
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
    expect((await f.runner.allocate(request)).trailId).toBe(trail.id); expect(calls).toBe(1);
  });
  test("uncertain checkout reconciles a completion marker without repeating commands", async () => {
    const f = fixture(); const original = f.client.writeFile; let failed = false;
    f.client.writeFile = async (id, path, bytes) => {
      if (path.endsWith("ephyra-checkout-receipt") && !failed) { failed = true; await original(id, path, bytes); throw new Error("response lost"); }
      await original(id, path, bytes);
    };
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
    const before = f.counts(); await f.runner.allocate(request); expect(f.counts()).toEqual(before);
  });
  test("uncertain unfinished checkout stays blocked and can be destroyed", async () => {
    const f = fixture(); let writes = 0;
    f.client.writeFile = async () => { writes++; throw new Error("unknown upload"); };
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired); expect(writes).toBe(1);
    const [lease] = await f.leaseStore.list(); await f.runner.destroy(lease!.handle); expect(f.counts().destroys).toBe(1);
  });
  test("checkpoint and teardown ambiguities reconcile by read without repeating mutation", async () => {
    const f = fixture(); const h = await f.runner.allocate(request); let captures = 0;
    f.client.checkpoint = async () => { captures++; throw new Error("lost checkpoint reply"); };
    await expect(f.runner.checkpoint(h)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(f.runner.checkpoint(h)).rejects.toBeInstanceOf(ReconciliationRequired);
    f.client.findCheckpoint = async () => "snapshot";
    expect(await f.runner.checkpoint(h)).toEqual({ snapshotId: "snapshot", kind: "disk" }); expect(captures).toBe(1);
    let teardown = 0;
    f.client.destroy = async () => { teardown++; throw new Error("lost destroy reply"); };
    await expect(f.runner.destroy(h)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(f.runner.destroy(h)).rejects.toBeInstanceOf(ReconciliationRequired);
    f.client.status = async () => "DESTROYED";
    expect((await f.runner.destroy(h)).destroyed).toBe(true); expect(teardown).toBe(1);
  });
  test("expired lease cleanup survives restart using durable file inventory", async () => {
    let now = Date.now(); const dir = await directory();
    const f = fixture({ now: () => now, leaseStore: new FileRailwayLeaseStore(dir) });
    const h = await f.runner.allocate(request); now += 31000;
    await expect(f.runner.readFile(h, "file")).rejects.toBeInstanceOf(LeaseExpired);
    const restarted = new RailwaySandboxRunner(new ArtifactStore("/unused"), f.client, { ...f.opts, leaseStore: new FileRailwayLeaseStore(dir) });
    expect(await restarted.reapExpired()).toEqual([{ handleId: h.id, remoteId: "remote-1", status: "destroyed" }]);
    expect(await restarted.reapExpired()).toEqual([]);
  });
  test("new process can reap an id observed before readiness failed", async () => {
    let now = Date.now(); const f = fixture({ now: () => now });
    f.client.create = async req => { await req.onCreated("partial-id"); throw new Error("readiness failed"); };
    await expect(f.runner.allocate(request)).rejects.toBeInstanceOf(ReconciliationRequired); now += 31000;
    const restarted = new RailwaySandboxRunner(new ArtifactStore("/unused"), f.client, f.opts);
    expect((await restarted.reapExpired())[0]?.remoteId).toBe("partial-id"); expect(f.counts().destroys).toBe(1);
  });
  test("exec timeout is clamped to remaining lease and profile budget", async () => {
    let now = Date.now(); const f = fixture({ now: () => now }); const h = await f.runner.allocate(request); now += 25000;
    let deadline = 0;
    f.client.exec = async function* (_id, _command, opts) { deadline = opts.deadlineMs; yield { exit: 7, durationMs: 1, timedOut: false }; };
    const outputs = [];
    for await (const output of f.runner.exec(h, ["false"], { deadlineMs: 60000 })) outputs.push(output);
    expect(deadline).toBe(5000); expect(outputs).toEqual([{ exit: 7, durationMs: 1, timedOut: false }]);
  });
  test("file transfer and exported artifact preserve exact bytes", async () => {
    const dir = await directory(); const f = fixture(); const runner = new RailwaySandboxRunner(new ArtifactStore(dir), f.client, f.opts);
    const h = await runner.allocate(request); const bytes = new Uint8Array([0, 1, 254, 255]);
    await runner.writeFile(h, "proof.bin", bytes); expect(await runner.readFile(h, "proof.bin")).toEqual(bytes);
    const [artifact] = await runner.exportArtifacts(h, ["proof.bin"]);
    expect(await new ArtifactStore(dir).get(artifact!.digest)).toEqual(bytes);
    await expect(runner.readFile(h, "../../etc/passwd")).rejects.toThrow("path");
  });
  test("replay count remains one across revisions and arbitrary repetitions", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 5 }), async (revision, repeats) => {
      const f = fixture(); const req = { ...request, trail: { ...trail, rev: revision } }; const first = await f.runner.allocate(req);
      for (let i = 0; i < repeats; i++) expect(await f.runner.allocate(req)).toEqual(first);
      expect(f.counts().creates).toBe(1);
      const second = await f.runner.allocate({ ...req, attempt: 2 });
      expect(second.id).not.toBe(first.id); expect(f.counts().creates).toBe(2);
    }), { numRuns: 25 });
  });
  test("shell quoting preserves arbitrary non-NUL text without expansion", async () => {
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 80 }).filter(s => !s.includes("\0")), async value => {
      const process = Bun.spawn(["sh", "-c", `printf '%s' ${railwayQuote(value)}`], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
      expect(await new Response(process.stdout).text()).toBe(value); expect(await process.exited).toBe(0);
    }), { numRuns: 50, examples: [["a'$(echo unexpected)`true` $HOME\n; hello"]] });
    expect(() => railwayQuote("a\0b")).toThrow("argument");
  });
});
