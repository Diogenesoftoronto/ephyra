import { createHash } from "node:crypto";
import {
  Sandbox, SandboxFileNotFoundError, SandboxNotFoundError,
  type ConnectOptions, type CreateOptions, type ExecOptions, type ExecResult,
  type FileWriteData, type SandboxCheckpointInfo, type SandboxStatus,
} from "railway";
import { ReconciliationRequired, Unverified } from "@ephyra/core";
import type { ExecOutput } from "@ephyra/core";
import type { RailwayCreateRequest, RailwaySandboxClient } from "./railway.ts";
import { railwayHash, railwayPath, railwayQuote } from "./railway-support.ts";

/** Deliberately narrow SDK seam. Production uses the pinned railway package. */
export interface RailwaySdkSandbox {
  id: string; environmentId: string; networkIsolation: "ISOLATED" | "PRIVATE"; status: SandboxStatus;
  exec(command: string, options?: ExecOptions): PromiseLike<ExecResult>;
  files: {
    write(path: string, data: FileWriteData): Promise<void>;
    read(path: string, options: { format: "stream" }): Promise<ReadableStream<Uint8Array>>;
  };
  checkpoint(name: string): Promise<SandboxCheckpointInfo>;
  destroy(): Promise<void>;
}
export interface RailwaySdk {
  create(sourceOrOptions: CreateOptions | string, options?: CreateOptions): Promise<RailwaySdkSandbox>;
  connect(id: string, options: ConnectOptions): Promise<RailwaySdkSandbox>;
  checkpoints(options: ConnectOptions): Promise<SandboxCheckpointInfo[]>;
}
export type RailwaySandboxConfig = {
  token: string;
  environmentId: string;
  /** SDK has no arbitrary image option. A named checkpoint is an operator-prepared disk image. */
  image: { kind: "default" } | { kind: "checkpoint"; name: string };
  idleTimeoutMinutes: number;
  authType?: "bearer" | "project-token";
  region?: string;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  lifecycleTimeoutMs?: number;
  fileTimeoutMs?: number;
  /** Transport seam for offline tests; requests still target Railway's fixed public endpoints. */
  fetch?: typeof fetch;
};

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const EXEC_ENDPOINT = "wss://ssh.railway.com:2226/ws/exec";
const checkpointName = (key: string) => `ephyra-${railwayHash(key)}`;
const positive = (value: number, max: number) => Number.isFinite(value) && value > 0 && value <= max;

/** A deadline bounds local waits; timing out a write never claims that the remote write stopped. */
async function bounded<T>(promise: PromiseLike<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error("Railway operation deadline exceeded")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function createRailwaySandboxClient(config: RailwaySandboxConfig, sdk: RailwaySdk = Sandbox): RailwaySandboxClient {
  // No ambient token, endpoint, environment, image, logging mode, or auth-type inheritance.
  if (typeof config.token !== "string" || !config.token.trim() || /[\x00-\x20\x7f]/.test(config.token) ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(config.environmentId) ||
      !Number.isInteger(config.idleTimeoutMinutes) || !positive(config.idleTimeoutMinutes, 120) ||
      !config.image || !["default", "checkpoint"].includes(config.image.kind) ||
      (config.image.kind === "checkpoint" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.image.name)) ||
      (config.region !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(config.region))) {
    throw new TypeError("explicit valid Railway token, environment, base image and idle timeout required");
  }
  config = Object.freeze({ ...config, image: Object.freeze({ ...config.image }) });
  const maxOutput = config.maxOutputBytes ?? 1024 * 1024;
  const maxFile = config.maxFileBytes ?? 64 * 1024 * 1024;
  const lifecycleTimeout = config.lifecycleTimeoutMs ?? 120000;
  const fileTimeout = config.fileTimeoutMs ?? 60000;
  if (!positive(maxOutput, 4 * 1024 * 1024) || !positive(maxFile, 256 * 1024 * 1024) ||
      !positive(lifecycleTimeout, 300000) || !positive(fileTimeout, 120000)) throw new TypeError("invalid Railway adapter bounds");
  const fetcher = config.fetch ?? globalThis.fetch;
  const scope = railwayHash({ environmentId: config.environmentId, image: config.image,
    authType: config.authType ?? "bearer", region: config.region ?? null });

  const connection = (signal?: AbortSignal, onCreated?: (id: string) => Promise<void>): ConnectOptions => ({
    token: config.token, environmentId: config.environmentId, authType: config.authType ?? "bearer",
    endpoint: ENDPOINT, tcpProxyWsEndpoint: EXEC_ENDPOINT, verbose: false,
    fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) !== ENDPOINT) throw new Error("unexpected Railway endpoint");
      const signals = [signal, init?.signal, AbortSignal.timeout(15000)].filter((s): s is AbortSignal => Boolean(s));
      const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
      // Capture the id before SDK readiness polling. This copy is bounded and never logged.
      // Return a fresh Response so the SDK sees exactly the same bytes, without retaining a clone branch.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        if (reader) while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > 1024 * 1024) throw new Error("Railway response exceeds limit");
          chunks.push(next.value);
        }
      } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (onCreated && response.ok) {
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const candidate = (body as { data?: { sandboxCreate?: { id?: unknown; environmentId?: unknown } } })?.data?.sandboxCreate;
        if (candidate && typeof candidate.id === "string" && candidate.environmentId === config.environmentId) {
          await onCreated(candidate.id);
        }
      }
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as typeof fetch,
  });
  const validate = (box: RailwaySdkSandbox, network?: "ISOLATED" | "PRIVATE") => {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(box.id) || box.environmentId !== config.environmentId ||
        (network !== undefined && box.networkIsolation !== network)) throw new Error("Railway resource identity mismatch");
    return box;
  };
  const connect = async (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new TypeError("invalid Railway resource id");
    return validate(await bounded(sdk.connect(id, connection()), 15000));
  };
  const create = async (req: RailwayCreateRequest, checkpoint?: string): Promise<string> => {
    const abort = new AbortController();
    if (req.limits.diskMb !== 0 || !positive(req.limits.cpu, Number.MAX_SAFE_INTEGER) ||
        !positive(req.limits.memoryMb, Number.MAX_SAFE_INTEGER) || !["ISOLATED", "PRIVATE"].includes(req.network)) {
      throw new TypeError("unsupported Railway resource constraints");
    }
    const options: CreateOptions = { ...connection(abort.signal, req.onCreated),
      idleTimeoutMinutes: config.idleTimeoutMinutes, networkIsolation: req.network,
      resources: { cpu: req.limits.cpu, memoryGB: req.limits.memoryMb / 1000 }, domains: [],
      // Public recovery metadata only; never account credentials or Railway variable references.
      env: { EPHYRA_OPERATION_KEY: railwayHash(req.operationKey), EPHYRA_LEASE_EXPIRES_AT: req.leaseExpiresAt },
      ...(!checkpoint && config.region ? { region: config.region } : {}),
    };
    try {
      const box = validate(await bounded(checkpoint ? sdk.create(checkpoint, options) : sdk.create(options),
        lifecycleTimeout, () => abort.abort()), req.network);
      await req.onCreated(box.id);
      if (box.status !== "RUNNING") throw new Error("Railway sandbox is not running");
      return box.id;
    } catch { throw new ReconciliationRequired(req.operationKey, "Railway create outcome requires reconciliation"); }
  };
  return {
    scope,
    create: req => create(req, config.image.kind === "checkpoint" ? config.image.name : undefined),
    restore: (snapshotId, req) => {
      if (!/^ephyra-[a-f0-9]{64}$/.test(snapshotId)) throw new TypeError("invalid Railway snapshot key");
      return create(req, snapshotId);
    },
    async *exec(id, command, opts) {
      if (!Array.isArray(command) || !command.length || command.length > 1024 || command.some(s => typeof s !== "string" || s.length > 65536) ||
          !positive(opts.deadlineMs, 24 * 60 * 60 * 1000)) throw new TypeError("invalid Railway command");
      const argv = command.map(railwayQuote).join(" ");
      if (argv.length > 256000) throw new TypeError("Railway command exceeds limit");
      const cwd = railwayPath(opts.cwd ?? "/workspace", true);
      const env = { ...(opts.env ?? {}) };
      if (Object.entries(env).length > 128 || Object.entries(env).some(([k, v]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ||
          typeof v !== "string" || v.includes("\0") || v.length > 32768 || v.includes(config.token))) {
        throw new TypeError("invalid Railway command environment");
      }
      const key = `railway:exec:${id}:${railwayHash({ argv, cwd, env })}`;
      const started = Date.now();
      let box: RailwaySdkSandbox;
      try { box = await connect(id); }
      catch { throw new Unverified("Railway command resource is unavailable; no command was dispatched"); }
      const remainingMs = opts.deadlineMs - (Date.now() - started);
      if (remainingMs <= 0) throw new Unverified("Railway command deadline expired before dispatch");
      const queue: ExecOutput[] = [];
      let bytes = 0, exceeded = false, done = false, failure: unknown, result: ExecResult | undefined;
      let wake: (() => void) | undefined;
      const capture = (stream: "stdout" | "stderr", chunk: string) => {
        bytes += new TextEncoder().encode(chunk).byteLength;
        if (bytes > maxOutput) exceeded = true;
        else if (chunk) queue.push({ stream, chunk });
        wake?.();
      };
      const abort = new AbortController();
      // SDK timeout confirms remote termination; the outer deadline handles setup/transport stalls.
      const timer = setTimeout(() => abort.abort(), remainingMs + 15000);
      const running = bounded(Promise.resolve().then(() => box.exec(argv, { cwd, env, ephemeral: true, captureOutput: false,
        maxOutputBytes: maxOutput, timeoutSec: remainingMs / 1000, signal: abort.signal,
        onStdout: chunk => capture("stdout", chunk), onStderr: chunk => capture("stderr", chunk),
      })), remainingMs + 25000, () => abort.abort()).then(value => { result = value; }, error => { failure = error; })
        .finally(() => { done = true; wake?.(); });
      try {
        while (!done || queue.length) {
          while (queue.length) yield queue.shift()!;
          if (!done) await new Promise<void>(resolve => { wake = resolve; });
        }
        if (failure || !result || result.exitCode === null || !Number.isInteger(result.exitCode)) {
          throw new ReconciliationRequired(key, "Railway command exit is unknown; do not repeat the command");
        }
        if (exceeded || result.truncated) throw new Unverified("Railway command output exceeded capture limit");
        yield { exit: result.exitCode, durationMs: Date.now() - started, timedOut: result.timedOut };
      } finally {
        clearTimeout(timer);
        if (!done) abort.abort();
        // Handles rejection when the consumer stops early without keeping this generator alive.
        void running;
      }
    },
    async writeFile(id, path, content) {
      const target = railwayPath(path);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      if (bytes.byteLength > maxFile) throw new TypeError("Railway file exceeds transfer limit");
      const key = `railway:write:${id}:${railwayHash({ target, content: createHash("sha256").update(bytes).digest("hex") })}`;
      try {
        const box = await connect(id);
        // Bare async iterable disables the SDK's automatic write retries.
        const once = (async function* () { for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536); })();
        await bounded(box.files.write(target, once), fileTimeout);
      } catch { throw new ReconciliationRequired(key, "Railway file write outcome requires reconciliation"); }
    },
    async readFile(id, path) {
      const target = railwayPath(path);
      let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | undefined;
      let cancelled = false;
      const read = async () => {
        const box = await connect(id);
        const activeReader = (await box.files.read(target, { format: "stream" })).getReader();
        reader = activeReader;
        if (cancelled) { await activeReader.cancel(); throw new Error("Railway file read deadline exceeded"); }
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const next = await activeReader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > maxFile) throw new Unverified("Railway file exceeds transfer limit");
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      };
      try { return await bounded(read(), fileTimeout, () => { cancelled = true; void reader?.cancel().catch(() => {}); }); }
      catch (error) {
        await reader?.cancel().catch(() => {});
        if (error instanceof SandboxFileNotFoundError) return null;
        throw new Unverified("Railway file could not be read completely");
      }
    },
    async checkpoint(id, operationKey) {
      const name = checkpointName(operationKey);
      try {
        const box = await connect(id);
        const snapshot = await bounded(box.checkpoint(name), lifecycleTimeout);
        if (snapshot.key !== name || snapshot.environmentId !== config.environmentId || !snapshot.id) throw new Error("checkpoint identity mismatch");
        return snapshot.key;
      } catch { throw new ReconciliationRequired(operationKey, "Railway checkpoint outcome requires reconciliation"); }
    },
    async findCheckpoint(operationKey) {
      const name = checkpointName(operationKey);
      try {
        const matches = (await bounded(sdk.checkpoints(connection()), 15000))
          .filter(item => item.key === name && item.environmentId === config.environmentId);
        return matches.length === 1 ? matches[0]!.key : null;
      } catch { throw new Unverified("Railway checkpoint inventory is unavailable"); }
    },
    async status(id, network) {
      try { return validate(await connect(id), network).status; }
      catch (error) { if (error instanceof SandboxNotFoundError) return "DESTROYED"; throw new Unverified("Railway resource status unavailable"); }
    },
    async destroy(id, operationKey) {
      try {
        const box = await connect(id);
        if (box.status !== "DESTROYED") await bounded(box.destroy(), lifecycleTimeout);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return;
        throw new ReconciliationRequired(operationKey, "Railway destroy outcome requires reconciliation");
      }
    },
  };
}
