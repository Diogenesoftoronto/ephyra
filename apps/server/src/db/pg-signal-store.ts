import { SQL } from "bun";
import { Signal, Unverified, type SignalStore } from "@ephyra/core";

function parseSignal(value: unknown): Signal {
  return Signal.parse(typeof value === "string" ? JSON.parse(value) : value);
}

/** Batches spanning a query boundary cannot be counted exactly and are rejected. */
export class PgSignalStore implements SignalStore {
  constructor(private readonly sql: SQL) {}

  async upsert(signal: Signal): Promise<{ signal: Signal; isNew: boolean }> {
    const valid = Signal.parse(signal);
    return this.sql.begin(async (tx) => {
      // Serializes both first insert and subsequent merges for a fingerprint.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${valid.fingerprint}, 0))`;
      const rows = await tx`SELECT signal FROM signals WHERE fingerprint = ${valid.fingerprint} FOR UPDATE`;
      const prior = rows[0] ? parseSignal(rows[0].signal) : null;
      const merged = prior ? {
        ...prior,
        count: prior.count + valid.count,
        firstSeen: prior.firstSeen < valid.firstSeen ? prior.firstSeen : valid.firstSeen,
        lastSeen: prior.lastSeen > valid.lastSeen ? prior.lastSeen : valid.lastSeen,
      } : valid;
      if (prior) {
        await tx`UPDATE signals SET signal = ${JSON.stringify(merged)}::jsonb WHERE id = ${prior.id}`;
      } else {
        await tx`INSERT INTO signals (id, fingerprint, signal) VALUES (${valid.id}, ${valid.fingerprint}, ${JSON.stringify(valid)}::jsonb)`;
      }
      await tx`INSERT INTO signal_occurrences (fingerprint, observed_at, count, first_seen)
        VALUES (${valid.fingerprint}, ${valid.lastSeen}, ${valid.count}, ${valid.firstSeen})`;
      return { signal: merged, isNew: !prior };
    });
  }

  async get(id: string): Promise<Signal | null> {
    const rows = await this.sql`SELECT signal FROM signals WHERE id = ${id}`;
    return rows[0] ? parseSignal(rows[0].signal) : null;
  }

  async byFingerprint(fingerprint: string): Promise<Signal | null> {
    const rows = await this.sql`SELECT signal FROM signals WHERE fingerprint = ${fingerprint}`;
    return rows[0] ? parseSignal(rows[0].signal) : null;
  }

  async countSince(fingerprint: string, since: Date): Promise<number> {
    const gaps = await this.sql`SELECT 1 FROM signal_occurrences WHERE fingerprint = ${fingerprint}
      AND observed_at >= ${since} AND (first_seen IS NULL OR first_seen < ${since}) LIMIT 1`;
    if (gaps.length) throw new Unverified("signal count across a partially observed batch");
    const rows = await this.sql`SELECT coalesce(sum(count), 0)::text AS count FROM signal_occurrences
      WHERE fingerprint = ${fingerprint} AND observed_at >= ${since}`;
    return Number(rows[0]!.count);
  }

  async newFingerprintsInFiles(files: string[], since: Date): Promise<Signal[]> {
    const rows = await this.sql`SELECT signal FROM signals WHERE (signal->>'firstSeen')::timestamptz >= ${since}`;
    const wanted = new Set(files);
    return rows.map((row: { signal: unknown }) => parseSignal(row.signal)).filter((signal: Signal) => {
      const frame = signal.frames.find((item) => item.inApp);
      return frame !== undefined && wanted.has(frame.file);
    });
  }

  async errorRate(_route: string, _from: Date, _to: Date): Promise<null> {
    // No request-count source is available in the signal store.
    return null;
  }

  async mute(fingerprint: string, until: Date): Promise<void> {
    await this.sql`UPDATE signals SET muted_until = ${until} WHERE fingerprint = ${fingerprint}`;
  }

  async isMuted(fingerprint: string, at: Date): Promise<boolean> {
    const rows = await this.sql`SELECT muted_until > ${at} AS muted FROM signals WHERE fingerprint = ${fingerprint}`;
    return rows[0]?.muted === true;
  }
}
