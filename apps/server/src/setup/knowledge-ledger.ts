import { createHash } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OperationLedger, OperationRecord } from "@ephyra/core";

const recordSchema = z.object({
  key: z.string(), planDigest: z.string(), at: z.string(),
  status: z.enum(["pending", "done", "reconciliation_required"]), result: z.unknown().optional(),
}).strict();
const exists = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EEXIST";
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Local durable tool receipts. An incomplete or corrupt claim fails closed, never authorizes a replay. */
export class KnowledgeOperationLedger implements OperationLedger {
  constructor(private readonly directory: string) {}

  private path(key: string, suffix: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.${suffix}`);
  }
  private async syncDirectory() {
    const handle = await open(this.directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async write(path: string, record: OperationRecord) {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
  }
  async get(key: string): Promise<OperationRecord | null> {
    let claim: OperationRecord;
    try { claim = recordSchema.parse(JSON.parse(await readFile(this.path(key, "claim"), "utf8"))); }
    catch (error) { if (missing(error)) return null; throw new Error("The knowledge operation receipt needs reconciliation."); }
    if (claim.key !== key || claim.status !== "pending") throw new Error("The knowledge operation receipt needs reconciliation.");
    try {
      const result = recordSchema.parse(JSON.parse(await readFile(this.path(key, "result"), "utf8")));
      if (result.key !== key || result.planDigest !== claim.planDigest || result.status === "pending")
        throw new Error("Invalid receipt");
      return result;
    } catch (error) { if (missing(error)) return claim; throw new Error("The knowledge operation receipt needs reconciliation."); }
  }
  async begin(key: string, planDigest: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await this.write(this.path(key, "claim"), { key, planDigest, status: "pending", at: new Date().toISOString() });
      await this.syncDirectory();
      return { fresh: true as const };
    } catch (error) {
      if (!exists(error)) throw error;
      const record = await this.get(key);
      if (!record || record.planDigest !== planDigest) throw new Error("The knowledge operation key was already used for another plan.");
      return { fresh: false as const, record };
    }
  }
  private async finish(key: string, status: "done" | "reconciliation_required", result: unknown) {
    const record = await this.get(key);
    if (!record || record.status !== "pending") throw new Error("The knowledge operation is not pending.");
    const temporary = this.path(key, `${crypto.randomUUID()}.tmp`);
    try {
      await this.write(temporary, { ...record, status, result });
      // Hard-link publishes a complete immutable outcome and cannot overwrite a racing reconciliation.
      await link(temporary, this.path(key, "result"));
      await this.syncDirectory();
    } finally { await unlink(temporary).catch(() => {}); }
  }
  complete(key: string, result: unknown) { return this.finish(key, "done", result); }
  markAmbiguous(key: string, note: string) { return this.finish(key, "reconciliation_required", note); }
}
