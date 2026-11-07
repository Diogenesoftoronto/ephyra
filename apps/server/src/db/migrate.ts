import { SQL } from "bun";

/** Apply each migration atomically under an advisory lock. */
export async function migrate(sql: SQL): Promise<void> {
  const migrations = ["001_initial", "002_signal_occurrences"];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(60321453)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY)`;
    for (const id of migrations) {
      const rows = await tx`SELECT id FROM schema_migrations WHERE id = ${id}`;
      if (rows.length === 0) {
        const migration = await Bun.file(new URL(`./migrations/${id}.sql`, import.meta.url)).text();
        await tx.unsafe(migration);
        await tx`INSERT INTO schema_migrations (id) VALUES (${id})`;
      }
    }
  });
}
