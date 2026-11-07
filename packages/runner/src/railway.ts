import { randomUUID } from "node:crypto";
import { ReconciliationRequired, Unverified } from "@ephyra/core";
import type { ArtifactRef, ExecOutput, Runner, RunnerHandle, ServiceProfile, Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { LeaseExpired } from "./local.ts";

/** Adapter boundary; injection does not imply that the real SDK has been verified. */
export interface RailwaySandboxClient {
  create(req: { operationKey: string; network: "ISOLATED" | "PRIVATE"; repoUrl: string; commit: string }): Promise<string>;
  exec(id: string, command: string[], opts: { cwd?: string; env?: Record<string, string>; deadlineMs: number }): AsyncIterable<ExecOutput>;
  writeFile(id: string, path: string, content: string | Uint8Array): Promise<void>;
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  checkpoint(id: string, operationKey: string): Promise<string>;
  restore(snapshotId: string, req: { operationKey: string; network: "ISOLATED" | "PRIVATE" }): Promise<string>;
  destroy(id: string, operationKey: string): Promise<void>;
}
export class UnsupportedRailwayNetwork extends Error {
  constructor(network: string) { super(`Railway cannot enforce network ${network}`); this.name = "UnsupportedRailwayNetwork"; }
}
export function railwayNetwork(network: ServiceProfile["network"]): "ISOLATED" | "PRIVATE" {
  if (network === "egress") return "ISOLATED";
  if (network === "private") return "PRIVATE";
  throw new UnsupportedRailwayNetwork(network);
}
export function defaultRailwayClient(): RailwaySandboxClient { throw new Unverified("Railway sandbox SDK client"); }

type State = { handle: RunnerHandle; remoteId: string };
export class RailwaySandboxRunner implements Runner {
  readonly name = "railway";
  readonly capabilities: Runner["capabilities"] = { checkpoint: "disk", network: ["egress", "private"], shell: true, browser: true };
  private readonly states = new Map<string, State>();
  private readonly receipts = new Map<string, { destroyed: true; at: string }>();
  constructor(private readonly cas: ArtifactStore, private readonly client: RailwaySandboxClient = defaultRailwayClient()) {}
  private state(handle: RunnerHandle, cleanup = false): State {
    const state = this.states.get(handle.id);
    if (!state || state.handle !== handle) throw new Error("unknown handle");
    if (!cleanup && Date.now() >= Date.parse(handle.leaseExpiresAt)) throw new LeaseExpired(handle.id);
    return state;
  }
  private makeHandle(id: string, remoteId: string, trail: Trail, attempt: number, seconds: number): RunnerHandle {
    const handle = { id, runner: this.name, workdir: "/workspace", trailId: trail.id, attempt,
      leaseExpiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    this.states.set(id, { handle, remoteId });
    return handle;
  }
  async allocate(req: { trail: Trail; attempt: number; repoUrl: string; commit: string; profile: ServiceProfile; leaseS?: number }): Promise<RunnerHandle> {
    const network = railwayNetwork(req.profile.network);
    const id = randomUUID();
    let remoteId: string;
    try { remoteId = await this.client.create({ operationKey: id, network, repoUrl: req.repoUrl, commit: req.commit }); }
    catch { throw new ReconciliationRequired(id, "sandbox creation outcome unknown"); }
    return this.makeHandle(id, remoteId, req.trail, req.attempt, req.leaseS ?? req.profile.limits.timeoutS);
  }
  async *exec(handle: RunnerHandle, command: string[], opts: { cwd?: string; env?: Record<string, string>; deadlineMs: number }): AsyncIterable<ExecOutput> {
    yield* this.client.exec(this.state(handle).remoteId, command, opts);
  }
  async writeFile(handle: RunnerHandle, path: string, content: string | Uint8Array): Promise<void> {
    await this.client.writeFile(this.state(handle).remoteId, path, content);
  }
  async readFile(handle: RunnerHandle, path: string): Promise<Uint8Array | null> {
    return this.client.readFile(this.state(handle).remoteId, path);
  }
  async checkpoint(handle: RunnerHandle): Promise<{ snapshotId: string; kind: "disk" }> {
    const state = this.state(handle);
    const key = randomUUID();
    try { return { snapshotId: await this.client.checkpoint(state.remoteId, key), kind: "disk" }; }
    catch { throw new ReconciliationRequired(key, "checkpoint outcome unknown"); }
  }
  async restore(snapshotId: string, req: { trail: Trail; attempt: number; profile: ServiceProfile }): Promise<RunnerHandle> {
    const network = railwayNetwork(req.profile.network);
    const id = randomUUID();
    let remoteId: string;
    try { remoteId = await this.client.restore(snapshotId, { operationKey: id, network }); }
    catch { throw new ReconciliationRequired(id, "restore outcome unknown"); }
    return this.makeHandle(id, remoteId, req.trail, req.attempt, req.profile.limits.timeoutS);
  }
  async exportArtifacts(handle: RunnerHandle, paths: string[]): Promise<ArtifactRef[]> {
    const refs: ArtifactRef[] = [];
    for (const path of paths) {
      const bytes = await this.readFile(handle, path);
      if (!bytes) throw new Error(`missing artifact: ${path}`);
      refs.push({ path, ...await this.cas.put(bytes), mediaType: "application/octet-stream" });
    }
    return refs;
  }
  async destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }> {
    const receipt = this.receipts.get(handle.id);
    if (receipt) return receipt;
    const state = this.state(handle, true);
    const key = `destroy:${handle.id}`;
    try { await this.client.destroy(state.remoteId, key); }
    catch { throw new ReconciliationRequired(key, "sandbox destruction outcome unknown"); }
    const result = { destroyed: true as const, at: new Date().toISOString() };
    this.states.delete(handle.id);
    this.receipts.set(handle.id, result);
    return result;
  }
}
