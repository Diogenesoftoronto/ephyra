import { createHash } from "node:crypto";
import { ReconciliationRequired, type Effect, type OperationLedger, type OperationRecord, type Trail } from "@ephyra/core";
import { canonicalJson } from "../audit.ts";
import type { EffectHandlers } from "../orchestrator.ts";

export class MemoryOperationLedger implements OperationLedger {
  private readonly records = new Map<string, OperationRecord>();

  async begin(key: string, planDigest: string): Promise<{ fresh: true } | { fresh: false; record: OperationRecord }> {
    const record = this.records.get(key);
    if (record) {
      if (record.planDigest !== planDigest) throw new Error(`operation key reused: ${key}`);
      return { fresh: false, record: structuredClone(record) };
    }
    this.records.set(key, { key, planDigest, status: "pending", at: new Date().toISOString() });
    return { fresh: true };
  }

  async complete(key: string, result: unknown): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status !== "pending") throw new Error("operation is not pending");
    this.records.set(key, { ...record, status: "done", result });
  }

  async markAmbiguous(key: string, note: string): Promise<void> {
    const record = this.records.get(key);
    if (!record || record.status !== "pending") throw new Error("operation is not pending");
    this.records.set(key, { ...record, status: "reconciliation_required", result: note });
  }

  async get(key: string): Promise<OperationRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }
}

export interface ReconciliationSink {
  record(key: string, note: string): Promise<void>;
}

/** A pending or ambiguous operation is never retried without reconciliation. */
export class EffectExecutor {
  constructor(
    private readonly ledger: OperationLedger,
    private readonly handlers: EffectHandlers,
    private readonly reconciliation: ReconciliationSink,
  ) {}

  async execute(effect: Effect, trail: Trail): Promise<void> {
    const digest = createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify({ effect, trail })))).digest("hex");
    const claim = await this.ledger.begin(effect.key, digest);
    if (!claim.fresh) {
      if (claim.record.status === "done") return;
      throw new ReconciliationRequired(effect.key, `operation is ${claim.record.status}`);
    }
    try {
      const handler = this.handlers[effect.type] as (effect: Effect, trail: Trail) => Promise<void>;
      await handler(effect, trail);
      await this.ledger.complete(effect.key, null);
    } catch (error) {
      // Keep the cause so an operator can reconcile; error text is bounded and never carries credentials.
      const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const note = `effect outcome requires reconciliation: ${cause.slice(0, 500)}`;
      await this.ledger.markAmbiguous(effect.key, note);
      await this.reconciliation.record(effect.key, note);
      throw new ReconciliationRequired(effect.key, note);
    }
  }
}
