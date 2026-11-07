import { SQL } from "bun";
import { hashAudit, type AuditEvent, type AuditInput } from "../audit.ts";

/** Serializes appenders so each persisted row extends the same chain. */
export class PgAudit {
  constructor(private readonly sql: SQL) {}

  async append(input: AuditInput): Promise<AuditEvent> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(60321454)`;
      const rows = await tx`SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1`;
      const prevHash = rows[0]?.hash ?? "";
      const hash = hashAudit(prevHash, input);
      await tx`INSERT INTO audit_events (id, row_data, prev_hash, hash)
        VALUES (${input.id}, ${JSON.stringify(input)}::jsonb, ${prevHash}, ${hash})`;
      return { ...input, prevHash, hash };
    });
  }
}
