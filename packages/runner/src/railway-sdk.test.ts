import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { SandboxFileNotFoundError, SandboxNotFoundError, type ConnectOptions, type CreateOptions,
  type ExecOptions, type ExecResult, type SandboxCheckpointInfo } from "railway";
import { ReconciliationRequired, Unverified, type ExecOutput, type ServiceProfile, type Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { createRailwaySandboxClient, type RailwaySandboxConfig, type RailwaySdk, type RailwaySdkSandbox } from "./railway-sdk.ts";
import { MemoryRailwayLeaseStore, MemoryRailwayOperationLedger, RailwaySandboxRunner, type RailwayCreateRequest } from "./railway.ts";

const config: RailwaySandboxConfig = { token: "explicit-secret-token", environmentId: "environment-A", image: { kind: "default" }, idleTimeoutMinutes: 1 };
const limits = { cpu: 1.5, memoryMb: 512, diskMb: 0, timeoutS: 30 };
const request: RailwayCreateRequest = { operationKey: "test-create-key", network: "ISOLATED", limits,
  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), onCreated: async () => {} };
const commit = "b".repeat(40);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fakeSdk() {
  const calls = { creates: [] as Array<{ source: CreateOptions | string; options?: CreateOptions }>, connects: [] as ConnectOptions[],
    execs: [] as Array<{ command: string; opts?: ExecOptions }>, writes: [] as string[], captures: [] as string[], destroys: 0 };
  const snapshots: SandboxCheckpointInfo[] = [];
  const boxes = new Map<string, RailwaySdkSandbox>();
  const files = new Map<string, Uint8Array>();
  let output: ExecResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  let execHook: ((opts?: ExecOptions) => Promise<ExecResult>) | undefined;
  const sdk: RailwaySdk = {
    async create(source, opts) {
      calls.creates.push({ source, options: opts });
      const options = typeof source === "string" ? opts! : source;
      const id = `sandbox-${calls.creates.length}`;
      const box: RailwaySdkSandbox = {
        id, environmentId: options.environmentId!, networkIsolation: options.networkIsolation!, status: "RUNNING",
        async exec(command, options) {
          calls.execs.push({ command, opts: options });
          if (execHook) return execHook(options);
          if (command.includes("'rev-parse' 'HEAD'")) options?.onStdout?.(`${commit}\n`);
          else {
            if (output.stdout) options?.onStdout?.(output.stdout);
            if (output.stderr) options?.onStderr?.(output.stderr);
          }
          return { ...output, stdout: options?.captureOutput === false ? "" : output.stdout, stderr: options?.captureOutput === false ? "" : output.stderr };
        },
        files: {
          async write(path, data) {
            calls.writes.push(path);
            expect(typeof data).not.toBe("string");
            expect(Symbol.asyncIterator in (data as object)).toBe(true);
            const chunks: Uint8Array[] = [];
            for await (const chunk of data as AsyncIterable<Uint8Array>) chunks.push(chunk);
            const length = chunks.reduce((total, c) => total + c.length, 0); const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            files.set(`${id}:${path}`, bytes);
          },
          async read(path) {
            const bytes = files.get(`${id}:${path}`);
            if (!bytes) throw new SandboxFileNotFoundError({ operation: "read", path, message: "missing" });
            return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
          },
        },
        async checkpoint(name) {
          calls.captures.push(name);
          const snapshot = { id: `checkpoint-${snapshots.length + 1}`, key: name, environmentId: box.environmentId, createdAt: new Date().toISOString() };
          snapshots.push(snapshot); return snapshot;
        },
        async destroy() { calls.destroys++; box.status = "DESTROYED"; },
      };
      boxes.set(id, box); return box;
    },
    async connect(id, opts) {
      calls.connects.push(opts);
      const box = boxes.get(id);
      if (!box) throw new SandboxNotFoundError({ id, environmentId: opts.environmentId! });
      return box;
    },
    async checkpoints() { return snapshots; },
  };
  return { sdk, calls, boxes, files, snapshots, setOutput: (value: ExecResult) => { output = value; },
    setExec: (hook: (opts?: ExecOptions) => Promise<ExecResult>) => { execHook = hook; } };
}
async function outputs(stream: AsyncIterable<ExecOutput>) { const result = []; for await (const item of stream) result.push(item); return result; }

describe("pinned Railway SDK adapter", () => {
  test("requires explicit identity and supported image without making SDK calls", () => {
    const f = fakeSdk();
    expect(() => createRailwaySandboxClient({ ...config, token: "" }, f.sdk)).toThrow("explicit valid");
    expect(() => createRailwaySandboxClient({ ...config, environmentId: "" }, f.sdk)).toThrow("explicit valid");
    expect(() => createRailwaySandboxClient({ ...config, image: { kind: "docker", name: "image" } as never }, f.sdk)).toThrow("explicit valid");
    expect(() => createRailwaySandboxClient({ ...config, idleTimeoutMinutes: 0 }, f.sdk)).toThrow("explicit valid");
    expect(f.calls.creates).toHaveLength(0);
  });
  test("passes explicit account identity, resource limits, network and finite idle timer", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk); await client.create(request);
    const passed = f.calls.creates[0]!.source as CreateOptions;
    expect(passed.token).toBe(config.token); expect(passed.environmentId).toBe(config.environmentId);
    expect(passed.authType).toBe("bearer"); expect(passed.endpoint).toBe("https://backboard.railway.com/graphql/v2");
    expect(passed.tcpProxyWsEndpoint).toBe("wss://ssh.railway.com:2226/ws/exec"); expect(passed.verbose).toBe(false);
    expect(passed.resources).toEqual({ cpu: 1.5, memoryGB: 0.512 }); expect(passed.networkIsolation).toBe("ISOLATED");
    expect(passed.idleTimeoutMinutes).toBe(1); expect(passed.domains).toEqual([]);
    expect(JSON.stringify(passed.env)).not.toContain(config.token); expect(Object.keys(passed.env!)).toHaveLength(2);
  });
  test("checkpoint image selection and restore use documented create overload", async () => {
    const f = fakeSdk();
    const client = createRailwaySandboxClient({ ...config, region: "us-east4-eqdc4a", image: { kind: "checkpoint", name: "ephyra-base" } }, f.sdk);
    const id = await client.create(request); expect(f.calls.creates[0]!.source).toBe("ephyra-base");
    expect(f.calls.creates[0]!.options?.region).toBeUndefined();
    const snapshot = await client.checkpoint(id, "capture-key");
    expect(await client.findCheckpoint!("capture-key")).toBe(snapshot);
    await client.restore(snapshot, { ...request, network: "PRIVATE" });
    expect(f.calls.creates[1]!.source).toBe(snapshot); expect(f.calls.creates[1]!.options?.networkIsolation).toBe("PRIVATE");
  });
  test("quotes argv, preserves cwd/env, bounds streaming and emits exact exit receipt", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk); const id = await client.create(request);
    f.setOutput({ exitCode: 23, stdout: "out", stderr: "err", timedOut: false, truncated: false });
    const results = await outputs(client.exec(id, ["printf", "a'$(touch unsafe)\n"], { cwd: "src", env: { CI: "true" }, deadlineMs: 2500 }));
    expect(results[0]).toEqual({ stream: "stdout", chunk: "out" }); expect(results[1]).toEqual({ stream: "stderr", chunk: "err" });
    expect(results[2]).toMatchObject({ exit: 23, timedOut: false });
    expect(f.calls.execs[0]!.command).toBe("'printf' 'a'\\''$(touch unsafe)\n'");
    expect(f.calls.execs[0]!.opts).toMatchObject({ cwd: "/workspace/src", env: { CI: "true" }, ephemeral: true, captureOutput: false });
    expect(f.calls.execs[0]!.opts!.timeoutSec).toBeGreaterThan(0);
    expect(f.calls.execs[0]!.opts!.timeoutSec).toBeLessThanOrEqual(2.5);
    expect(f.calls.connects[0]!.token).toBe(config.token);
  });
  test("null or interrupted exit is ambiguous while a confirmed timeout preserves provider code", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk); const id = await client.create(request);
    f.setOutput({ exitCode: null, stdout: "partial", stderr: "", timedOut: true, truncated: false });
    await expect(outputs(client.exec(id, ["run"], { deadlineMs: 500 }))).rejects.toBeInstanceOf(ReconciliationRequired);
    f.setOutput({ exitCode: -1, stdout: "", stderr: "", timedOut: true, truncated: false });
    expect((await outputs(client.exec(id, ["run"], { deadlineMs: 500 })))[0]).toMatchObject({ exit: -1, timedOut: true });
    f.setExec(async () => { throw new Error(`transport secret ${config.token}`); });
    try { await outputs(client.exec(id, ["run"], { deadlineMs: 500 })); throw new Error("should fail"); }
    catch (error) { expect(error).toBeInstanceOf(ReconciliationRequired); expect(String(error)).not.toContain(config.token); }
  });
  test("truncated output never becomes complete proof", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient({ ...config, maxOutputBytes: 4 }, f.sdk); const id = await client.create(request);
    f.setOutput({ exitCode: 0, stdout: "too-long", stderr: "", timedOut: false, truncated: false });
    await expect(outputs(client.exec(id, ["run"], { deadlineMs: 500 }))).rejects.toBeInstanceOf(Unverified);
  });
  test("file I/O is bounded, one-shot, preserves bytes, and missing data stays missing", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient({ ...config, maxFileBytes: 4 }, f.sdk); const id = await client.create(request);
    const bytes = new Uint8Array([0, 255, 1]); await client.writeFile(id, "result.bin", bytes);
    expect(await client.readFile(id, "result.bin")).toEqual(bytes); expect(await client.readFile(id, "missing")).toBeNull();
    await expect(client.writeFile(id, "large", new Uint8Array(5))).rejects.toThrow("limit");
    f.files.set(`${id}:/workspace/large`, new Uint8Array(5));
    await expect(client.readFile(id, "large")).rejects.toBeInstanceOf(Unverified);
    await expect(client.readFile(id, "/etc/passwd")).rejects.toThrow("path");
    await expect(client.writeFile(id, "../escape", "x")).rejects.toThrow("path");
  });
  test("file timeout does not claim a write was cancelled or retry it", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient({ ...config, fileTimeoutMs: 5 }, f.sdk); const id = await client.create(request);
    let calls = 0; f.boxes.get(id)!.files.write = async () => { calls++; await new Promise(() => {}); };
    await expect(client.writeFile(id, "file", "x")).rejects.toBeInstanceOf(ReconciliationRequired); expect(calls).toBe(1);
  });
  test("resource from another environment is rejected and raw errors remain private", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk); const id = await client.create(request);
    f.boxes.get(id)!.environmentId = "other-environment";
    await expect(client.readFile(id, "file")).rejects.toBeInstanceOf(Unverified);
    await expect(client.destroy(id, "destroy-key")).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(f.calls.destroys).toBe(0);
  });
  test("configuration cannot change identity after client creation and delayed connect cannot overrun dispatch deadline", async () => {
    const f = fakeSdk(); const mutable = { ...config }; const client = createRailwaySandboxClient(mutable, f.sdk);
    mutable.token = "other-token"; mutable.environmentId = "other-environment";
    const id = await client.create(request);
    expect((f.calls.creates[0]!.source as CreateOptions).token).toBe(config.token);
    const connect = f.sdk.connect;
    f.sdk.connect = async (resource, options) => { await Bun.sleep(5); return connect(resource, options); };
    await expect(outputs(client.exec(id, ["command"], { deadlineMs: 1 }))).rejects.toBeInstanceOf(Unverified);
    expect(f.calls.execs).toHaveLength(0);
  });
  test("synchronous SDK command and lookup errors never expose raw provider text", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk); const id = await client.create(request);
    f.boxes.get(id)!.exec = () => { throw new Error(config.token); };
    let error: unknown;
    try { await outputs(client.exec(id, ["command"], { deadlineMs: 1000 })); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ReconciliationRequired); expect(String(error)).not.toContain(config.token);
    f.sdk.checkpoints = async () => { throw new Error(config.token); };
    await expect(client.findCheckpoint!("key")).rejects.toThrow("inventory is unavailable");
  });
  test("SDK mutation response records resource id before readiness throws", async () => {
    const f = fakeSdk(); const observed: string[] = [];
    const fetch = (async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ data: { sandboxCreate: { id: "created-id", environmentId: config.environmentId } } });
    }) as typeof globalThis.fetch;
    f.sdk.create = async (options) => {
      await (options as CreateOptions).fetch!("https://backboard.railway.com/graphql/v2", { method: "POST", body: "{}" });
      expect(observed).toEqual(["created-id"]);
      throw new Error(`readiness failure ${config.token}`);
    };
    const client = createRailwaySandboxClient({ ...config, fetch }, f.sdk);
    await expect(client.create({ ...request, onCreated: async id => { observed.push(id); } })).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(observed).toEqual(["created-id"]);
  });
  test("full runner path uses SDK allocate, bundle transfer, commands, artifact export and destroy", async () => {
    const f = fakeSdk(); const client = createRailwaySandboxClient(config, f.sdk);
    const dir = await mkdtemp(join(tmpdir(), "ephyra-sdk-test-")); directories.push(dir);
    const profile: ServiceProfile = { name: "p", digest: "x", network: "egress", readOnlyProd: true, credentials: [], limits };
    const options = { scope: "did:plc:test/workspace", ledger: new MemoryRailwayOperationLedger(), leaseStore: new MemoryRailwayLeaseStore(),
      repositoryBundle: async () => ({ bytes: new Uint8Array([1, 2, 3]), ref: "refs/ephyra/setup" }) };
    const runner = new RailwaySandboxRunner(new ArtifactStore(dir), client, options);
    const req = { trail: { id: "t", rev: 1 } as Trail, attempt: 1, repoUrl: "/private/host-mirror.git", commit, profile };
    const handle = await runner.allocate(req);
    expect(f.calls.creates).toHaveLength(1); expect(f.calls.execs).toHaveLength(5);
    expect(JSON.stringify(f.calls.execs)).not.toContain(req.repoUrl); expect(JSON.stringify(f.calls.execs)).not.toContain(config.token);
    await runner.writeFile(handle, "proof.txt", "passed fixture");
    const [artifact] = await runner.exportArtifacts(handle, ["proof.txt"]);
    expect(new TextDecoder().decode(await new ArtifactStore(dir).get(artifact!.digest))).toBe("passed fixture");
    const restart = new RailwaySandboxRunner(new ArtifactStore(dir), createRailwaySandboxClient(config, f.sdk), options);
    expect(await restart.allocate(req)).toEqual(handle); expect(f.calls.creates).toHaveLength(1);
    const checkpoint = await restart.checkpoint(handle);
    const restored = await restart.restore(checkpoint.snapshotId, { trail: req.trail, attempt: 2, profile });
    await restart.destroy(handle); await restart.destroy(restored); expect(f.calls.destroys).toBe(2);
  });
  for (const format of ["sha1", "sha256"] as const) for (const shallow of [false, true]) {
    test(`real ${shallow ? "depth-1" : "full"} ${format} bundle materializes through the SDK fake without a remote`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ephyra-sdk-git-")); directories.push(dir);
    const source = join(dir, "source"), workspace = join(dir, "sandbox"), bundlePath = join(dir, "source.bundle");
    await mkdir(source);
    const env = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const run = async (argv: string[]) => {
      const process = Bun.spawn(argv, { cwd: source, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (exit !== 0) throw new Error(`offline Git fixture failed: ${stderr}`);
      return stdout.trim();
    };
    await run(["git", "init", `--object-format=${format}`, "--initial-branch=main", "."]);
    for (const version of [1, 2, 3]) {
      await writeFile(join(source, "app.txt"), version === 3 ? "real fixture content\n" : `fixture version ${version}\n`);
      await run(["git", "add", "app.txt"]);
      await run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", `fixture ${version}`]);
    }
    const exactCommit = await run(["git", "rev-parse", "HEAD"]);
    const mirror = join(dir, "mirror.git");
    await run(["git", "clone", "--bare", ...(shallow ? ["--depth=1"] : []), pathToFileURL(source).href, mirror]);
    await run(["git", "--git-dir", mirror, "update-ref", "refs/ephyra/setup", exactCommit]);
    await run(["git", "--git-dir", mirror, "bundle", "create", bundlePath, "refs/ephyra/setup"]);
    const f = fakeSdk(); const create = f.sdk.create;
    f.sdk.create = async (first, second) => {
      const box = await create(first, second);
      box.files.write = async (path, data) => {
        const target = path.replace("/workspace", workspace); await mkdir(dirname(target), { recursive: true });
        const chunks: Uint8Array[] = [];
        for await (const chunk of data as AsyncIterable<Uint8Array>) chunks.push(chunk);
        await writeFile(target, Buffer.concat(chunks));
      };
      box.files.read = async path => {
        const bytes = await readFile(path.replace("/workspace", workspace));
        return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      };
      box.exec = async (command, opts) => {
        const process = Bun.spawn(["sh", "-c", command.replaceAll("/workspace", workspace)], {
          cwd: opts!.cwd!.replace("/workspace", workspace), env: { ...env, ...opts?.env }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
        if (stdout) opts?.onStdout?.(stdout); if (stderr) opts?.onStderr?.(stderr);
        return { stdout: "", stderr: "", exitCode, truncated: false, timedOut: false };
      };
      return box;
    };
    const runner = new RailwaySandboxRunner(new ArtifactStore(join(dir, "cas")), createRailwaySandboxClient(config, f.sdk), {
      scope: "did:plc:git-fixture/repo", repositoryBundle: async () => ({ bytes: await readFile(bundlePath), ref: "refs/ephyra/setup",
        ...(shallow ? { shallow: [exactCommit] } : {}) }),
    });
    const profile: ServiceProfile = { name: "fixture", digest: "ignored", network: "egress", readOnlyProd: true, credentials: [], limits };
    const handle = await runner.allocate({ trail: { id: "git", rev: 1 } as Trail, attempt: 1, repoUrl: source, commit: exactCommit, profile });
    expect(new TextDecoder().decode((await runner.readFile(handle, "app.txt"))!)).toBe("real fixture content\n");
    expect(await run(["git", "-C", workspace, "rev-parse", "HEAD"])).toBe(exactCommit);
    expect(await run(["git", "-C", workspace, "rev-parse", "--is-shallow-repository"])).toBe(String(shallow));
    expect(await run(["git", "-C", workspace, "rev-list", "--count", "HEAD"])).toBe(shallow ? "1" : "3");
    const remote = await outputs(runner.exec(handle, ["git", "remote", "-v"], { deadlineMs: 1000 }));
    expect(remote.filter(item => "stream" in item)).toEqual([]);
    await runner.destroy(handle);
    });
  }
});
