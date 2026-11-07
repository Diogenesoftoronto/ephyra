import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactRef, ExecOutput, Runner, RunnerHandle, ServiceProfile, Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";

export class LeaseExpired extends Error {
  constructor(id: string) { super(`lease expired: ${id}`); this.name = "LeaseExpired"; }
}

let nextPort = 20000;

type Allocation = { trail: Trail; attempt: number; repoUrl: string; commit: string; profile: ServiceProfile; leaseS?: number };
type State = { handle: RunnerHandle; mirror: string; profile: ServiceProfile; port: number };
type Snapshot = { bytes: Uint8Array; repoUrl: string; commit: string };

async function command(args: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit !== 0) throw new Error(`${args[0]} failed: ${stderr}`);
}

export class LocalRunner implements Runner {
  readonly name = "local";
  // Local processes do not enforce network isolation or resource limits.
  readonly capabilities: Runner["capabilities"] = { checkpoint: "disk", network: ["egress"], shell: true, browser: true };
  private states = new Map<string, State>();
  private snapshots = new Map<string, Snapshot>();
  private destroyed = new Map<string, { destroyed: true; at: string }>();
  private readonly cas: ArtifactStore;

  constructor(private readonly root: string, private readonly options: { trusted: true; allowDevenv?: boolean }) {
    if (options.trusted !== true) throw new Error("local execution requires trusted code");
    this.cas = new ArtifactStore(join(root, "artifacts"));
  }

  private state(handle: RunnerHandle, allowExpired = false): State {
    const state = this.states.get(handle.id);
    if (!state || state.handle !== handle) throw new Error("unknown handle");
    if (!allowExpired && Date.now() >= Date.parse(state.handle.leaseExpiresAt)) throw new LeaseExpired(handle.id);
    return state;
  }

  async allocate(req: Allocation): Promise<RunnerHandle> {
    if (req.profile.network !== "egress") throw new Error("local runner cannot enforce network policy");
    const mirror = join(this.root, "mirrors", createHash("sha256").update(req.repoUrl).digest("hex") + ".git");
    await mkdir(dirname(mirror), { recursive: true });
    try { await access(mirror); } catch { await command(["git", "clone", "--mirror", "--", req.repoUrl, mirror]); }
    await command(["git", "--git-dir", mirror, "fetch", "--prune", "origin"]);
    const id = randomUUID();
    const workdir = resolve(this.root, "worktrees", id);
    await mkdir(dirname(workdir), { recursive: true });
    await command(["git", "--git-dir", mirror, "worktree", "add", "--detach", workdir, req.commit]);
    const handle: RunnerHandle = {
      id, runner: this.name, workdir, trailId: req.trail.id, attempt: req.attempt,
      leaseExpiresAt: new Date(Date.now() + (req.leaseS ?? req.profile.limits.timeoutS) * 1000).toISOString(),
    };
    this.states.set(id, { handle, mirror, profile: req.profile, port: nextPort++ });
    return handle;
  }

  private async confined(handle: RunnerHandle, path: string, missing = false): Promise<string> {
    this.state(handle);
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("path escapes workdir");
    const base = await realpath(handle.workdir);
    const target = resolve(base, path);
    let part = base;
    for (const component of relative(base, target).split(sep).filter(Boolean)) {
      part = join(part, component);
      try {
        if ((await lstat(part)).isSymbolicLink()) throw new Error("symlink path rejected");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !missing) throw error;
        break;
      }
    }
    let check = target;
    while (true) {
      try { check = await realpath(check); break; } catch (error) {
        if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT" || check === base) throw error;
        check = dirname(check);
      }
    }
    const rel = relative(base, check);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes workdir");
    return target;
  }

  async *exec(handle: RunnerHandle, args: string[], opts: { cwd?: string; env?: Record<string, string>; deadlineMs: number }): AsyncIterable<ExecOutput> {
    const state = this.state(handle);
    if (!args.length || opts.deadlineMs <= 0) throw new Error("invalid command or deadline");
    const cwd = await this.confined(handle, opts.cwd ?? ".");
    const home = join(handle.workdir, ".ephyra-home");
    await mkdir(home, { recursive: true });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: process.env.LANG ?? "C.UTF-8",
      TERM: process.env.TERM ?? "dumb", ...opts.env, HOME: home, CI: "1", AI_AGENT: "ephyra",
      EPHYRA_PORT_BASE: String(state.port),
    };
    let executable = args;
    if (this.options.allowDevenv && await Bun.file(join(handle.workdir, "devenv.nix")).exists()) {
      executable = ["devenv", "shell", "--", ...args];
    }
    const start = Date.now();
    const proc = Bun.spawn(["setsid", ...executable], { cwd, env, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; try { process.kill(-proc.pid, "SIGKILL"); } catch {} }, opts.deadlineMs);
    const queue: ExecOutput[] = [];
    let wake: (() => void) | undefined;
    const pump = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        queue.push({ stream: name, chunk: decoder.decode(item.value, { stream: true }) });
        wake?.();
      }
      const tail = decoder.decode();
      if (tail) { queue.push({ stream: name, chunk: tail }); wake?.(); }
    };
    let finished = false;
    const done = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"), proc.exited]).then((results) => {
      clearTimeout(timeout);
      queue.push({ exit: results[2], durationMs: Date.now() - start, timedOut });
      finished = true;
      wake?.();
    });
    try {
      while (!finished || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolveWake) => { wake = resolveWake; });
        wake = undefined;
      }
      await done;
    } finally {
      clearTimeout(timeout);
      if (!finished) { try { process.kill(-proc.pid, "SIGKILL"); } catch {} await done; }
    }
  }

  async writeFile(handle: RunnerHandle, path: string, content: string | Uint8Array): Promise<void> {
    const target = await this.confined(handle, path, true);
    await writeFile(target, content);
  }
  async readFile(handle: RunnerHandle, path: string): Promise<Uint8Array | null> {
    try { return await readFile(await this.confined(handle, path)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async checkpoint(handle: RunnerHandle): Promise<{ snapshotId: string; kind: "disk" }> {
    const state = this.state(handle);
    const file = join(this.root, `snapshot-${randomUUID()}.tar`);
    try {
      await command(["tar", "--exclude=./.git", "-cf", file, "-C", handle.workdir, "."]);
      const bytes = await readFile(file);
      const { digest } = await this.cas.put(bytes);
      const repoUrl = (await Bun.$`git --git-dir ${state.mirror} config --get remote.origin.url`.quiet()).text().trim();
      const commit = (await Bun.$`git -C ${handle.workdir} rev-parse HEAD`.quiet()).text().trim();
      this.snapshots.set(digest, { bytes, repoUrl, commit });
      return { snapshotId: digest, kind: "disk" };
    } finally { await rm(file, { force: true }); }
  }
  async restore(snapshotId: string, req: { trail: Trail; attempt: number; profile: ServiceProfile }): Promise<RunnerHandle> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error("unknown snapshot");
    const handle = await this.allocate({ ...req, repoUrl: snapshot.repoUrl, commit: snapshot.commit });
    const file = join(this.root, `restore-${randomUUID()}.tar`);
    try {
      await writeFile(file, snapshot.bytes);
      for (const entry of await readdir(handle.workdir)) {
        if (entry !== ".git") await rm(join(handle.workdir, entry), { recursive: true, force: true });
      }
      await command(["tar", "-xf", file, "-C", handle.workdir]);
      return handle;
    } catch (error) { await this.destroy(handle); throw error; }
    finally { await rm(file, { force: true }); }
  }
  async exportArtifacts(handle: RunnerHandle, paths: string[]): Promise<ArtifactRef[]> {
    const result: ArtifactRef[] = [];
    for (const path of paths) {
      const bytes = await this.readFile(handle, path);
      if (!bytes) throw new Error(`missing artifact: ${path}`);
      result.push({ path, ...await this.cas.put(bytes), mediaType: "application/octet-stream" });
    }
    return result;
  }
  async destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }> {
    const existing = this.destroyed.get(handle.id);
    if (existing) return existing;
    const state = this.state(handle, true);
    await command(["git", "--git-dir", state.mirror, "worktree", "remove", "--force", handle.workdir]);
    await command(["git", "--git-dir", state.mirror, "worktree", "prune"]);
    await rm(join(this.root, "homes", handle.id), { recursive: true, force: true });
    this.states.delete(handle.id);
    const receipt = { destroyed: true as const, at: new Date().toISOString() };
    this.destroyed.set(handle.id, receipt);
    return receipt;
  }
}
