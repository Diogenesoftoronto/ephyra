import { randomUUID } from "node:crypto";
import { ReconciliationRequired, Unverified } from "@ephyra/core";
import type { ArtifactRef, ExecOutput, Runner, RunnerHandle, ServiceProfile, Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { LeaseExpired } from "./local.ts";

type Run = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stdout?: string; stderr?: string; exit_code?: number };
type State = { handle: RunnerHandle; files: Map<string, Uint8Array>; active?: string };
export class NotOrganicSandboxRunner implements Runner {
  readonly name = "notorganic";
  readonly capabilities: Runner["capabilities"] = { checkpoint: "none", network: ["none"], shell: false, browser: false };
  private states = new Map<string, State>();
  private receipts = new Map<string, { destroyed: true; at: string }>();
  constructor(private readonly options: { baseUrl: string; projectId: string; maxCostMicrousd: number;
    fetch: (input: string, init?: RequestInit) => Promise<Response>; cas: ArtifactStore; pollMs?: number }) {}
  private state(handle: RunnerHandle, cleanup = false): State {
    const state = this.states.get(handle.id);
    if (!state || state.handle !== handle) throw new Error("unknown handle");
    if (!cleanup && Date.now() >= Date.parse(handle.leaseExpiresAt)) throw new LeaseExpired(handle.id);
    return state;
  }
  async allocate(req: { trail: Trail; attempt: number; repoUrl: string; commit: string; profile: ServiceProfile; leaseS?: number }): Promise<RunnerHandle> {
    if (req.profile.network !== "none") throw new Error("Not Organic requires no network");
    const id = randomUUID();
    const handle = { id, runner: this.name, workdir: "/", trailId: req.trail.id, attempt: req.attempt,
      leaseExpiresAt: new Date(Date.now() + (req.leaseS ?? req.profile.limits.timeoutS) * 1000).toISOString() };
    this.states.set(id, { handle, files: new Map() });
    return handle;
  }
  private filename(path: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(py|ts)$/.test(path) || path.length > 128) throw new Error("invalid script filename");
    return path;
  }
  async writeFile(handle: RunnerHandle, path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
    if (!bytes.length || bytes.length > 256000) throw new Error("script size outside limit");
    this.state(handle).files.set(this.filename(path), bytes);
  }
  async readFile(handle: RunnerHandle, path: string): Promise<Uint8Array | null> {
    return this.state(handle).files.get(this.filename(path))?.slice() ?? null;
  }
  private async request(path: string, init?: RequestInit): Promise<Run> {
    const response = await this.options.fetch(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, init);
    if (!response.ok) throw new Error(`sandbox HTTP ${response.status}`);
    const run = await response.json() as Run;
    if (!run.id || !["queued", "running", "succeeded", "failed", "cancelled"].includes(run.status)) {
      throw new Error("invalid sandbox response");
    }
    return run;
  }
  async *exec(handle: RunnerHandle, command: string[], opts: { cwd?: string; env?: Record<string, string>; deadlineMs: number }): AsyncIterable<ExecOutput> {
    const state = this.state(handle);
    if (state.active || command.length !== 2 || opts.cwd || Object.keys(opts.env ?? {}).length || opts.deadlineMs <= 0) {
      throw new Error("expected a single script without shell, cwd or environment");
    }
    const [runtime, filename] = command as [string, string];
    const language = runtime === "python" && filename.endsWith(".py") ? "python" :
      runtime === "typescript" && filename.endsWith(".ts") ? "typescript" : null;
    const code = await this.readFile(handle, filename);
    if (!language || !code) throw new Error("script or runtime invalid");
    const key = randomUUID();
    const start = Date.now();
    let run: Run;
    try {
      run = await this.request("/v1/sandbox/runs", { method: "POST", headers: {
        "content-type": "application/json", "idempotency-key": key,
      }, body: JSON.stringify({ project_id: this.options.projectId, code: new TextDecoder().decode(code), language,
        filename, max_cost_microusd: this.options.maxCostMicrousd }) });
    } catch { throw new ReconciliationRequired(key, "sandbox submission outcome unknown"); }
    state.active = run.id;
    const deadline = start + Math.min(opts.deadlineMs, 30000);
    while (run.status === "queued" || run.status === "running") {
      if (Date.now() >= deadline || Date.now() >= Date.parse(handle.leaseExpiresAt)) {
        const cancelKey = `cancel:${run.id}`;
        try { run = await this.request(`/v1/sandbox/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST" }); }
        catch { throw new ReconciliationRequired(cancelKey, "sandbox cancellation outcome unknown"); }
        if (run.status === "queued" || run.status === "running") throw new ReconciliationRequired(cancelKey, "cancellation not confirmed");
        state.active = undefined;
        yield { exit: run.exit_code ?? 1, durationMs: Date.now() - start, timedOut: true };
        return;
      }
      await Bun.sleep(Math.min(this.options.pollMs ?? 250, Math.max(1, deadline - Date.now())));
      run = await this.request(`/v1/sandbox/runs/${encodeURIComponent(run.id)}`);
    }
    state.active = undefined;
    if (new TextEncoder().encode((run.stdout ?? "") + (run.stderr ?? "")).length > 256000) throw new Error("sandbox output exceeds limit");
    if (run.stdout) yield { stream: "stdout", chunk: run.stdout };
    if (run.stderr) yield { stream: "stderr", chunk: run.stderr };
    yield { exit: run.exit_code ?? (run.status === "succeeded" ? 0 : 1), durationMs: Date.now() - start, timedOut: false };
  }
  async checkpoint(handle: RunnerHandle): Promise<{ snapshotId: string; kind: "disk" }> {
    this.state(handle); throw new Unverified("Not Organic checkpoints unsupported");
  }
  async restore(_snapshotId: string, _req: { trail: Trail; attempt: number; profile: ServiceProfile }): Promise<RunnerHandle> {
    throw new Unverified("Not Organic checkpoints unsupported");
  }
  async exportArtifacts(handle: RunnerHandle, paths: string[]): Promise<ArtifactRef[]> {
    const refs: ArtifactRef[] = [];
    for (const path of paths) {
      const bytes = await this.readFile(handle, path);
      if (!bytes) throw new Error("missing artifact");
      refs.push({ path, ...await this.options.cas.put(bytes), mediaType: "application/octet-stream" });
    }
    return refs;
  }
  async destroy(handle: RunnerHandle): Promise<{ destroyed: true; at: string }> {
    const receipt = this.receipts.get(handle.id);
    if (receipt) return receipt;
    const state = this.state(handle, true);
    if (state.active) {
      const key = `cancel:${state.active}`;
      let result: Run;
      try { result = await this.request(`/v1/sandbox/runs/${encodeURIComponent(state.active)}/cancel`, { method: "POST" }); }
      catch { throw new ReconciliationRequired(key, "sandbox cancellation outcome unknown"); }
      if (result.status === "queued" || result.status === "running") throw new ReconciliationRequired(key, "cancellation not confirmed");
    }
    this.states.delete(handle.id);
    const result = { destroyed: true as const, at: new Date().toISOString() };
    this.receipts.set(handle.id, result);
    return result;
  }
}
