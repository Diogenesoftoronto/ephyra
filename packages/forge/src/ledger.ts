import type { OperationLedger, OperationRecord } from "@ephyra/core";

/** Process-local ledger. Inject a durable ledger for recovery across restarts. */
export class MemoryOperationLedger implements OperationLedger {
  private readonly records = new Map<string, OperationRecord>();

  async begin(key: string, planDigest: string) {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.planDigest !== planDigest)
        throw new Error("idempotency key reused with a different plan");
      return { fresh: false as const, record: structuredClone(existing) };
    }
    this.records.set(key, {
      key,
      planDigest,
      status: "pending",
      at: new Date().toISOString(),
    });
    return { fresh: true as const };
  }

  async complete(key: string, result: unknown): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status !== "pending")
      throw new Error("operation is not pending");
    this.records.set(key, {
      ...record,
      status: "done",
      result: structuredClone(result),
    });
  }

  async markAmbiguous(key: string, note: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status !== "pending")
      throw new Error("operation is not pending");
    this.records.set(key, {
      ...record,
      status: "reconciliation_required",
      result: note,
    });
  }

  async get(key: string): Promise<OperationRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }
}
