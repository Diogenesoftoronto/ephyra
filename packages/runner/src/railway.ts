import { ReconciliationRequired, Unverified } from "@ephyra/core";
import type { ArtifactRef, ExecOutput, OperationLedger, Runner, RunnerHandle, ServiceProfile, Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { LeaseExpired } from "./local.ts";
import { profileDigest } from "./profile.ts";
import { createRailwaySandboxClient, type RailwaySandboxConfig } from "./railway-sdk.ts";
import {
  MemoryRailwayLeaseStore, MemoryRailwayOperationLedger, railwayCanonical, railwayHash, railwayPath,
  type RailwayLease, type RailwayLeaseStore,
} from "./railway-support.ts";
export { FileRailwayLeaseStore, MemoryRailwayLeaseStore, MemoryRailwayOperationLedger } from "./railway-support.ts";
export type { RailwayLease, RailwayLeaseStore } from "./railway-support.ts";
export { createRailwaySandboxClient } from "./railway-sdk.ts";
export type { RailwaySandboxConfig, RailwaySdk, RailwaySdkSandbox } from "./railway-sdk.ts";

export type RailwayCreateRequest = {
  operationKey: string; network: "ISOLATED" | "PRIVATE"; limits: ServiceProfile["limits"];
  leaseExpiresAt: string;
  /** Persist the real resource id before the SDK starts polling for RUNNING. */
  onCreated: (id: string) => Promise<void>;
};
export type RailwayExecOptions = { cwd?: string; env?: Record<string, string>; deadlineMs: number };
export interface RailwaySandboxClient {
  /** Binds operation keys to the explicitly configured provider environment/base. */
  readonly scope?: string;
  create(req: RailwayCreateRequest): Promise<string>;
  exec(id: string, command: string[], opts: RailwayExecOptions): AsyncIterable<ExecOutput>;
  writeFile(id: string, path: string, content: string | Uint8Array): Promise<void>;
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  checkpoint(id: string, operationKey: string): Promise<string>;
  restore(snapshotId: string, req: RailwayCreateRequest): Promise<string>;
  destroy(id: string, operationKey: string): Promise<void>;
  status?(id: string, network?: "ISOLATED" | "PRIVATE"): Promise<"RUNNING" | "CREATING" | "DESTROYED" | "DESTROYING" | "FAILED">;
  findCheckpoint?(operationKey: string): Promise<string | null>;
}
export class UnsupportedRailwayNetwork extends Error {
  constructor(network: string) { super(`Railway cannot enforce network ${network}`); this.name = "UnsupportedRailwayNetwork"; }
}
export class UnsupportedRailwayConstraint extends Error {
  constructor(constraint: string) { super(`Railway cannot enforce ${constraint}`); this.name = "UnsupportedRailwayConstraint"; }
}
export function railwayNetwork(network: ServiceProfile["network"]): "ISOLATED" | "PRIVATE" {
  if (network === "egress") return "ISOLATED";
  if (network === "private") return "PRIVATE";
  throw new UnsupportedRailwayNetwork(network);
}
export function validateRailwayProfile(profile: ServiceProfile): void {
  railwayNetwork(profile.network);
  if (profile.limits.diskMb !== 0) throw new UnsupportedRailwayConstraint("a hard disk quota (diskMb must explicitly be 0)");
  for (const value of [profile.limits.cpu, profile.limits.memoryMb, profile.limits.timeoutS]) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError("invalid Railway resource limit");
  }
  if (profile.credentials.length) throw new UnsupportedRailwayConstraint("production credential mediation");
  if (profile.egressAllowlist?.length) throw new UnsupportedRailwayConstraint("an egress allowlist");
}
export function defaultRailwayClient(config?: RailwaySandboxConfig): RailwaySandboxClient {
  if (!config) throw new Unverified("explicit Railway sandbox configuration required");
  return createRailwaySandboxClient(config);
}

export type RailwayRepositoryBundle = {
  bytes: Uint8Array; ref: string;
  /** Selected code history's missing-parent boundaries; Git bundle files do not encode them. */
  shallow?: string[];
};
export type RailwayRunnerOptions = {
  ledger?: OperationLedger;
  leaseStore?: RailwayLeaseStore;
  /** Bind to the authenticated owner and workspace, not a display alias. */
  scope?: string;
  repositoryBundle?: (req: { repoUrl: string; commit: string }) => Promise<RailwayRepositoryBundle>;
  onLease?: (handle: RunnerHandle) => Promise<void>;
  now?: () => number;
};
type AllocateRequest = Parameters<Runner["allocate"]>[0] & { operationKey?: string };
type RestoreRequest = Parameters<Runner["restore"]>[1] & { operationKey?: string; leaseS?: number };

export class RailwaySandboxRunner implements Runner {
  readonly name = "railway";
  // Browser binaries are image-dependent and are not assumed to be installed.
  readonly capabilities: Runner["capabilities"] = { checkpoint: "disk", network: ["egress", "private"], shell: true, browser: false };
  private readonly ledger: OperationLedger;
  private readonly leases: RailwayLeaseStore;
  private readonly scope: string;
  private readonly now: () => number;
  constructor(private readonly cas: ArtifactStore, private readonly client: RailwaySandboxClient = defaultRailwayClient(),
    private readonly options: RailwayRunnerOptions = {}) {
    this.ledger = options.ledger ?? new MemoryRailwayOperationLedger();
    this.leases = options.leaseStore ?? new MemoryRailwayLeaseStore();
    this.scope = railwayHash({ owner: options.scope ?? "development", provider: client.scope ?? "injected" });
    this.now = options.now ?? Date.now;
  }
  private async state(handle: RunnerHandle, cleanup = false): Promise<RailwayLease> {
    const record = await this.ledger.get(`railway:resource:${handle.id}`);
    const state = record?.status === "done" ? record.result as RailwayLease : undefined;
    if (!state || state.scope !== this.scope || railwayCanonical(state.handle) !== railwayCanonical(handle)) {
      throw new Error("unknown Railway handle");
    }
    if (!cleanup) {
      const destroyed = await this.effective(`railway:destroy:${handle.id}`);
      if (destroyed?.status === "done") throw new Error("Railway handle already destroyed");
      if (this.now() >= Date.parse(handle.leaseExpiresAt)) throw new LeaseExpired(handle.id);
      const allocation = await this.effective(state.allocationKey);
      if (allocation?.status !== "done") throw new ReconciliationRequired(state.allocationKey, "sandbox readiness requires reconciliation");
    }
    return state;
  }
  private async ambiguous(key: string, reason: string): Promise<never> {
    if ((await this.ledger.get(key))?.status === "pending") await this.ledger.markAmbiguous(key, reason);
    throw new ReconciliationRequired(key, reason);
  }
  private async effective(key: string) {
    const record = await this.ledger.get(key);
    if (record?.status === "done") return record;
    const resolution = await this.ledger.get(`${key}:reconciled`);
    return resolution?.status === "done" ? resolution : record;
  }
  /** Operation outcomes are immutable. Read reconciliation gets a separate durable receipt. */
  private async reconcile(key: string, result: unknown): Promise<void> {
    const prior = await this.ledger.get(key);
    if (!prior) throw new Error("unknown Railway operation");
    const resolutionKey = `${key}:reconciled`;
    const claim = await this.ledger.begin(resolutionKey, railwayHash({ key, plan: prior.planDigest }));
    if (claim.fresh) await this.ledger.complete(resolutionKey, result);
    else if (claim.record.status !== "done" || railwayCanonical(claim.record.result) !== railwayCanonical(result)) {
      throw new ReconciliationRequired(key, "Railway reconciliation receipt is incomplete or changed");
    }
  }
  private async provision(req: AllocateRequest | RestoreRequest, source: { repoUrl: string; commit: string } | { snapshotId: string }): Promise<RailwayLease> {
    validateRailwayProfile(req.profile);
    const seconds = req.leaseS ?? req.profile.limits.timeoutS;
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(req.attempt) || req.attempt < 1) {
      throw new TypeError("invalid Railway lease or attempt");
    }
    const identity = { scope: this.scope, trail: req.trail.id, revision: req.trail.rev, attempt: req.attempt,
      profile: profileDigest(req.profile), operationKey: req.operationKey ?? null, kind: "snapshotId" in source ? "restore" : "allocate" };
    const id = `railway-${railwayHash(identity)}`;
    const key = `railway:allocate:${id}`;
    // Hash repository locators: even an accidental credential in a locator is never persisted.
    const plan = { identity, source: railwayHash(source), leaseS: seconds };
    const claim = await this.ledger.begin(key, railwayHash(plan));
    if (!claim.fresh) {
      const resource = await this.ledger.get(`railway:resource:${id}`);
      const known = resource?.status === "done" ? resource.result as RailwayLease : undefined;
      if (known?.scope === this.scope && (await this.effective(key))?.status === "done") {
        await this.state(known.handle);
        return known;
      }
      // A known id can be reconciled by a read; an unobserved create is never repeated.
      if (known?.scope === this.scope && this.client.status && await this.client.status(known.remoteId, known.network) === "RUNNING") {
        await this.leases.put(known);
        await this.options.onLease?.(structuredClone(known.handle));
        await this.reconcile(key, known.handle);
        await this.state(known.handle);
        return known;
      }
      throw new ReconciliationRequired(key, "sandbox creation requires reconciliation; no new sandbox was created");
    }
    const handle: RunnerHandle = { id, runner: this.name, workdir: "/workspace", trailId: req.trail.id,
      attempt: req.attempt, leaseExpiresAt: new Date(this.now() + seconds * 1000).toISOString() };
    const network = railwayNetwork(req.profile.network);
    const onCreated = async (remoteId: string) => {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(remoteId)) throw new Error("invalid Railway resource id");
      const state: RailwayLease = { version: 1, scope: this.scope, handle, remoteId, allocationKey: key,
        network, timeoutS: req.profile.limits.timeoutS };
      const resourceKey = `railway:resource:${id}`;
      const resource = await this.ledger.begin(resourceKey, railwayHash({ ...plan, remoteId }));
      if (resource.fresh || resource.record.status !== "done") await this.ledger.complete(resourceKey, state);
      await this.leases.put(state);
      await this.options.onLease?.(structuredClone(handle));
    };
    const create: RailwayCreateRequest = { operationKey: key, network, limits: req.profile.limits,
      leaseExpiresAt: handle.leaseExpiresAt, onCreated };
    try {
      const remoteId = "snapshotId" in source ? await this.client.restore(source.snapshotId, create) : await this.client.create(create);
      await onCreated(remoteId); // Also supports injected clients without the early-response hook.
      await this.ledger.complete(key, handle);
      return await this.state(handle);
    } catch {
      return this.ambiguous(key, "sandbox creation or readiness outcome requires reconciliation");
    }
  }
  async allocate(req: AllocateRequest): Promise<RunnerHandle> {
    validateRailwayProfile(req.profile);
    if (!this.options.repositoryBundle) throw new Unverified("credential-free repository bundle transport required");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(req.commit)) throw new TypeError("exact Git commit required");
    const state = await this.provision(req, { repoUrl: req.repoUrl, commit: req.commit });
    const key = `railway:checkout:${state.handle.id}`;
    const plan = railwayHash({ commit: req.commit, source: railwayHash(req.repoUrl), remoteId: state.remoteId });
    const claim = await this.ledger.begin(key, plan);
    const marker = ".git/ephyra-checkout-receipt";
    if (!claim.fresh) {
      if ((await this.effective(key))?.status === "done") return state.handle;
      const receipt = await this.client.readFile(state.remoteId, marker);
      if (receipt && new TextDecoder().decode(receipt) === plan) {
        await this.reconcile(key, { commit: req.commit });
        return state.handle;
      }
      throw new ReconciliationRequired(key, "repository checkout requires reconciliation; it was not repeated");
    }
    try {
      const bundle = await this.options.repositoryBundle({ repoUrl: req.repoUrl, commit: req.commit });
      if (!(bundle.bytes instanceof Uint8Array) || !bundle.bytes.length || bundle.bytes.length > 256 * 1024 * 1024 ||
          !/^refs\/[a-zA-Z0-9/_-]+$/.test(bundle.ref) || bundle.ref.includes("//")) throw new TypeError("invalid prepared Git bundle");
      const shallow = bundle.shallow === undefined ? [] : bundle.shallow;
      if (!Array.isArray(shallow) || shallow.length > 4096 || new Set(shallow).size !== shallow.length ||
          shallow.some((value) => typeof value !== "string" || value.length !== req.commit.length || !/^[a-f0-9]+$/.test(value))) {
        throw new TypeError("invalid prepared Git shallow boundaries");
      }
      // Fixed, bounded paths; neither the locator nor credentials enter the VM.
      // The files API creates /workspace and .git before exec needs its cwd.
      await this.client.writeFile(state.remoteId, ".git/ephyra-source.bundle", bundle.bytes);
      const git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always"];
      await this.checkedExec(state, [...git, "init", `--object-format=${req.commit.length === 64 ? "sha256" : "sha1"}`, "."]);
      if (shallow.length) await this.client.writeFile(state.remoteId, ".git/shallow", `${shallow.join("\n")}\n`);
      await this.checkedExec(state, [...git, "fetch", "--no-tags", "--", "/workspace/.git/ephyra-source.bundle", bundle.ref]);
      await this.checkedExec(state, [...git, "-c", "filter.lfs.required=false", "checkout", "--detach", "--force", req.commit]);
      const head = await this.checkedExec(state, [...git, "rev-parse", "HEAD"]);
      if (head.trim() !== req.commit) throw new Unverified("sandbox checkout does not match requested commit");
      await this.checkedExec(state, ["rm", "--", "/workspace/.git/ephyra-source.bundle"]);
      await this.client.writeFile(state.remoteId, marker, plan);
      await this.ledger.complete(key, { commit: req.commit });
      return state.handle;
    } catch {
      return this.ambiguous(key, "sandbox repository setup did not complete; inspect or destroy the recorded resource");
    }
  }
  private async checkedExec(state: RailwayLease, command: string[]): Promise<string> {
    let stdout = "", exited = false;
    for await (const item of this.exec(state.handle, command, { deadlineMs: state.timeoutS * 1000 })) {
      if ("exit" in item) {
        if (item.exit !== 0 || item.timedOut) throw new Unverified("sandbox repository setup command failed");
        exited = true;
      } else if (item.stream === "stdout") stdout += item.chunk;
    }
    if (!exited) throw new Unverified("sandbox repository setup exit unavailable");
    return stdout;
  }
  async *exec(handle: RunnerHandle, command: string[], opts: RailwayExecOptions): AsyncIterable<ExecOutput> {
    const state = await this.state(handle);
    if (!Number.isFinite(opts.deadlineMs) || opts.deadlineMs <= 0) throw new TypeError("invalid command deadline");
    yield* this.client.exec(state.remoteId, command, { ...opts, cwd: railwayPath(opts.cwd ?? "/workspace", true),
      deadlineMs: Math.min(opts.deadlineMs, state.timeoutS * 1000, Date.parse(handle.leaseExpiresAt) - this.now()) });
  }
  async writeFile(handle: RunnerHandle, path: string, content: string | Uint8Array): Promise<void> {
    await this.client.writeFile((await this.state(handle)).remoteId, railwayPath(path), content);
  }
  async readFile(handle: RunnerHandle, path: string): Promise<Uint8Array | null> {
    return this.client.readFile((await this.state(handle)).remoteId, railwayPath(path));
  }
  /** Without an explicit key, one immutable checkpoint per handle is captured. */
  async checkpoint(handle: RunnerHandle, operationKey = "default"): Promise<{ snapshotId: string; kind: "disk" }> {
    const state = await this.state(handle);
    const key = `railway:checkpoint:${railwayHash({ scope: this.scope, id: handle.id, operationKey })}`;
    const claim = await this.ledger.begin(key, railwayHash({ remoteId: state.remoteId, scope: this.scope }));
    let snapshotId: string;
    if (!claim.fresh) {
      const effective = await this.effective(key);
      if (effective?.status === "done") return effective.result as { snapshotId: string; kind: "disk" };
      const found = await this.client.findCheckpoint?.(key);
      if (!found) throw new ReconciliationRequired(key, "checkpoint outcome requires reconciliation; capture was not repeated");
      snapshotId = found;
    } else {
      try { snapshotId = await this.client.checkpoint(state.remoteId, key); }
      catch { return this.ambiguous(key, "checkpoint outcome requires reconciliation"); }
    }
    const result = { snapshotId, kind: "disk" as const };
    const binding = `railway:snapshot:${railwayHash(snapshotId)}`;
    const bindingClaim = await this.ledger.begin(binding, railwayHash({ scope: this.scope, key }));
    if (bindingClaim.fresh || bindingClaim.record.status === "pending") await this.ledger.complete(binding, { scope: this.scope, snapshotId });
    else if (bindingClaim.record.status !== "done") throw new ReconciliationRequired(key, "checkpoint binding requires reconciliation");
    if (claim.fresh) await this.ledger.complete(key, result);
    else await this.reconcile(key, result);
    return result;
  }
  async restore(snapshotId: string, req: RestoreRequest): Promise<RunnerHandle> {
    validateRailwayProfile(req.profile);
    const binding = await this.ledger.get(`railway:snapshot:${railwayHash(snapshotId)}`);
    if (binding?.status !== "done" || (binding.result as { scope: string }).scope !== this.scope) {
      throw new Error("unknown Railway checkpoint for this owner/workspace");
    }
    return (await this.provision(req, { snapshotId })).handle;
  }
  async exportArtifacts(handle: RunnerHandle, paths: string[]): Promise<ArtifactRef[]> {
    const refs: ArtifactRef[] = [];
    if (paths.length > 100) throw new TypeError("too many sandbox artifacts");
    for (const path of paths) {
      const bytes = await this.readFile(handle, path);
      if (!bytes) throw new Unverified("sandbox artifact unavailable");
      refs.push({ path, ...await this.cas.put(bytes), mediaType: "application/octet-stream" });
    }
    return refs;
  }
  async destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }> {
    const state = await this.state(handle, true);
    const key = `railway:destroy:${handle.id}`;
    const claim = await this.ledger.begin(key, railwayHash({ remoteId: state.remoteId, scope: this.scope }));
    if (!claim.fresh) {
      const effective = await this.effective(key);
      if (effective?.status === "done") {
        await this.leases.remove(handle.id);
        return effective.result as { destroyed: true; at: string };
      }
      if (!this.client.status || await this.client.status(state.remoteId) !== "DESTROYED") {
        throw new ReconciliationRequired(key, "sandbox destruction requires reconciliation; destroy was not repeated");
      }
    } else {
      try { await this.client.destroy(state.remoteId, key); }
      catch { return this.ambiguous(key, "sandbox destruction outcome requires reconciliation"); }
    }
    const result = { destroyed: true as const, at: new Date(this.now()).toISOString() };
    if (claim.fresh) await this.ledger.complete(key, result);
    else await this.reconcile(key, result);
    await this.leases.remove(handle.id);
    return result;
  }
  /** Durable inventory lets a new process reap expired resources without allocating replacements. */
  async reapExpired(): Promise<Array<{ handleId: string; remoteId: string; status: "destroyed" | "reconciliation_required" }>> {
    const results: Array<{ handleId: string; remoteId: string; status: "destroyed" | "reconciliation_required" }> = [];
    for (const lease of await this.leases.list()) {
      if (lease.scope !== this.scope || Date.parse(lease.handle.leaseExpiresAt) > this.now()) continue;
      try {
        await this.destroy(lease.handle);
        results.push({ handleId: lease.handle.id, remoteId: lease.remoteId, status: "destroyed" });
      } catch {
        results.push({ handleId: lease.handle.id, remoteId: lease.remoteId, status: "reconciliation_required" });
      }
    }
    return results;
  }
}
