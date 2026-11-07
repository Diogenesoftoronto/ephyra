import { UsageEntry, type UsageEntry as Entry, type UsageTotals } from "@ephyra/core";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

export interface UsageStore {
  record(entry: Entry): Promise<void>;
  list(): Promise<Entry[]>;
}
export class MemoryUsageStore implements UsageStore {
  private entries = new Map<string, Entry>();
  async record(entry: Entry): Promise<void> {
    const valid = UsageEntry.parse(entry);
    if (!this.entries.has(valid.idempotencyKey)) this.entries.set(valid.idempotencyKey, valid);
  }
  async list(): Promise<Entry[]> { return [...this.entries.values()].map((entry) => UsageEntry.parse(entry)); }
}
export class ConvexUsageStore implements UsageStore {
  constructor(private client: ConvexHttpClient, private secret: string) {}
  async record(entry: Entry): Promise<void> {
    const valid = UsageEntry.parse(entry);
    await this.client.mutation(api.usage.record, { secret: this.secret, key: valid.idempotencyKey, json: JSON.stringify(valid) });
  }
  async list(): Promise<Entry[]> {
    return (await this.client.query(api.usage.list, { secret: this.secret })).map((row) => UsageEntry.parse(JSON.parse(row)));
  }
}
export function usageTotals(entries: Entry[]): UsageTotals {
  return entries.reduce<UsageTotals>((t, entry) => ({
    entries: t.entries + 1, costMicrousd: t.costMicrousd + (entry.costMicrousd ?? 0),
    unknownCost: t.unknownCost + Number(entry.costMicrousd === null), tokens: t.tokens + (entry.tokens ?? 0),
    wallMs: t.wallMs + (entry.wallMs ?? 0), failed: t.failed + Number(entry.outcome === "failed"),
    unavailable: t.unavailable + Number(entry.outcome === "unavailable"),
  }), { entries: 0, costMicrousd: 0, unknownCost: 0, tokens: 0, wallMs: 0, failed: 0, unavailable: 0 });
}
