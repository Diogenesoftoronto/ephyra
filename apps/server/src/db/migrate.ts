import { SQL } from "bun";

/** Apply each migration atomically under an advisory lock. */
export async function migrate(sql: SQL): Promise<void> {
  const migration = await Bun.file(new URL("./migrations/001_initial.sql", import.meta.url)).text();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(60321453)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY)`;
    const rows = await tx`SELECT id FROM schema_migrations WHERE id = ${"001_initial"}`;
    if (rows.length === 0) {
      await tx.unsafe(migration);
      await tx`INSERT INTO schema_migrations (id) VALUES (${"001_initial"})`;
    }
  });
}
