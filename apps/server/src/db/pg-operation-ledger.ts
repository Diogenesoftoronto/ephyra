import { SQL } from "bun";
import type { OperationLedger, OperationRecord } from "@ephyra/core";

export class PgOperationLedger implements OperationLedger {
  constructor(private readonly sql: SQL) {}

  async begin(key: string, planDigest: string): Promise<{ fresh: true } | { fresh: false; record: OperationRecord }> {
    const inserted = await this.sql`
      INSERT INTO operation_ledger (key, plan_digest, status) VALUES (${key}, ${planDigest}, 'pending')
      ON CONFLICT (key) DO NOTHING RETURNING key`;
    if (inserted.length) return { fresh: true };
    const record = await this.get(key);
    if (!record) throw new Error("operation disappeared");
    if (record.planDigest !== planDigest) throw new Error(`operation key reused: ${key}`);
    return { fresh: false, record };
  }

  async complete(key: string, result: unknown): Promise<void> {
    const rows = await this.sql`UPDATE operation_ledger SET status = 'done', result = ${JSON.stringify(result)}::jsonb
      WHERE key = ${key} AND status = 'pending' RETURNING key`;
    if (!rows.length) throw new Error("operation is not pending");
  }

  async markAmbiguous(key: string, note: string): Promise<void> {
    const rows = await this.sql`UPDATE operation_ledger SET status = 'reconciliation_required', result = ${JSON.stringify(note)}::jsonb
      WHERE key = ${key} AND status = 'pending' RETURNING key`;
    if (!rows.length) throw new Error("operation is not pending");
  }

  async get(key: string): Promise<OperationRecord | null> {
    const rows = await this.sql`SELECT key, plan_digest, status, result, at FROM operation_ledger WHERE key = ${key}`;
    const row = rows[0];
    if (!row) return null;
    return { key: row.key, planDigest: row.plan_digest, status: row.status, result: row.result, at: new Date(row.at).toISOString() };
  }
}
