import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, posix } from "node:path";
import type { OperationLedger, OperationRecord, RunnerHandle } from "@ephyra/core";

export function railwayCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(railwayCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${railwayCanonical(v)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("non-JSON Railway operation plan");
  return result;
}
export const railwayHash = (value: unknown): string => createHash("sha256").update(railwayCanonical(value)).digest("hex");
export function railwayQuote(argument: string): string {
  if (typeof argument !== "string" || argument.includes("\0")) throw new TypeError("invalid command argument");
  return `'${argument.replaceAll("'", "'\\''")}'`;
}
export function railwayPath(path: string, directory = false): string {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || path.split("/").includes("..")) {
    throw new TypeError("invalid sandbox path");
  }
  const result = posix.resolve("/workspace", path);
  if (!(result.startsWith("/workspace/") || (directory && result === "/workspace"))) {
    throw new TypeError("sandbox path must be inside /workspace");
  }
  return result;
}

export type RailwayLease = {
  version: 1; scope: string; handle: RunnerHandle; remoteId: string; allocationKey: string;
  network: "ISOLATED" | "PRIVATE"; timeoutS: number;
};
export interface RailwayLeaseStore {
  put(lease: RailwayLease): Promise<void>;
  list(): Promise<RailwayLease[]>;
  remove(id: string): Promise<void>;
}
/** Contains resource ids and immutable leases, never credentials or repository bytes. */
export class FileRailwayLeaseStore implements RailwayLeaseStore {
  constructor(private readonly directory: string) {}
  private path(id: string): string {
    if (!/^railway-[a-f0-9]{64}$/.test(id)) throw new TypeError("invalid Railway handle id");
    return join(this.directory, `${id}.json`);
  }
  async put(lease: RailwayLease): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(lease.handle.id);
    // The operation claim serializes creation; an atomic rename prevents a torn inventory entry.
    const temp = `${path}.${randomUUID()}.pending`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(lease)); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temp, path);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
  async list(): Promise<RailwayLease[]> {
    const names = await readdir(this.directory).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const result: RailwayLease[] = [];
    for (const name of names) {
      if (!/^railway-[a-f0-9]{64}\.json$/.test(name)) continue;
      const bytes = await readFile(join(this.directory, name));
      if (bytes.length > 16384) throw new Error("invalid Railway lease inventory");
      const lease = JSON.parse(bytes.toString()) as RailwayLease;
      if (lease.version !== 1 || typeof lease.remoteId !== "string" || typeof lease.scope !== "string" ||
          lease.handle?.id !== name.slice(0, -5) || !Number.isFinite(Date.parse(lease.handle.leaseExpiresAt))) {
        throw new Error("invalid Railway lease inventory");
      }
      result.push(lease);
    }
    return result;
  }
  async remove(id: string): Promise<void> {
    await unlink(this.path(id)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  }
}

/** Test/development defaults. Production must inject durable implementations. */
export class MemoryRailwayLeaseStore implements RailwayLeaseStore {
  private readonly records = new Map<string, RailwayLease>();
  async put(lease: RailwayLease) { this.records.set(lease.handle.id, structuredClone(lease)); }
  async list() { return Array.from(this.records.values(), r => structuredClone(r)); }
  async remove(id: string) { this.records.delete(id); }
}
export class MemoryRailwayOperationLedger implements OperationLedger {
  private readonly records = new Map<string, OperationRecord>();
  async begin(key: string, planDigest: string) {
    const record = this.records.get(key);
    if (record) {
      if (record.planDigest !== planDigest) throw new Error("Railway operation plan changed");
      return { fresh: false as const, record: structuredClone(record) };
    }
    this.records.set(key, { key, planDigest, status: "pending", at: new Date().toISOString() });
    return { fresh: true as const };
  }
  async complete(key: string, result: unknown) {
    const record = this.records.get(key);
    if (!record || record.status !== "pending") throw new Error("Railway operation is not pending");
    this.records.set(key, { ...record, status: "done", result: structuredClone(result) });
  }
  async markAmbiguous(key: string, _note: string) {
    const record = this.records.get(key);
    if (!record || record.status !== "pending") throw new Error("Railway operation is not pending");
    this.records.set(key, { ...record, status: "reconciliation_required" });
  }
  async get(key: string) { return structuredClone(this.records.get(key) ?? null); }
}
