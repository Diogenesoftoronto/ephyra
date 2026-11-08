import { AccountSettings } from "@ephyra/core";
import type { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../convex/_generated/api";

/** Server-only account state. Credential strings are already sealed; this store never opens them. */
export type AccountRecord = { settings: AccountSettings; modelKey?: string; repoToken?: string; telemetryKey?: string; peopleToken?: string };
export type AccountBeginResult =
  | { status: "fresh" }
  | { status: "completed"; record: AccountRecord }
  | { status: "failed"; error: string }
  | { status: "pending" | "conflict" };

export interface AccountStore {
  ensure(initial: AccountRecord): Promise<AccountRecord>;
  get(did: string): Promise<AccountRecord | null>;
  list(): Promise<AccountRecord[]>;
  begin(did: string, key: string, digest: string, expectedVersion: number): Promise<AccountBeginResult>;
  complete(did: string, key: string, digest: string, record: AccountRecord): Promise<boolean>;
  fail(did: string, key: string, digest: string, error: string): Promise<void>;
}

const accountRecord = z
  .object({
    settings: AccountSettings,
    modelKey: z.string().optional(),
    repoToken: z.string().optional(),
    telemetryKey: z.string().optional(),
    peopleToken: z.string().optional(),
  })
  .strict();
const decode = (json: string): AccountRecord => accountRecord.parse(JSON.parse(json));

type Operation = {
  digest: string;
  expectedVersion: number;
  status: "pending" | "completed" | "failed";
  result?: AccountRecord;
  error?: string;
};

export class MemoryAccountStore implements AccountStore {
  private readonly records = new Map<string, AccountRecord>();
  private readonly operations = new Map<string, Map<string, Operation>>();

  async ensure(initial: AccountRecord): Promise<AccountRecord> {
    const parsed = accountRecord.parse(initial);
    const did = parsed.settings.did;
    if (!this.records.has(did)) this.records.set(did, parsed);
    return structuredClone(this.records.get(did)!);
  }

  async get(did: string): Promise<AccountRecord | null> {
    const record = this.records.get(did);
    return record ? structuredClone(record) : null;
  }

  async list(): Promise<AccountRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async begin(did: string, key: string, digest: string, expectedVersion: number): Promise<AccountBeginResult> {
    const operation = this.operations.get(did)?.get(key);
    if (operation) {
      if (operation.digest !== digest) return { status: "conflict" };
      if (operation.status === "completed") {
        if (!operation.result) throw new Error("account receipt is missing");
        return { status: "completed", record: structuredClone(operation.result) };
      }
      if (operation.status === "failed")
        return { status: "failed", error: operation.error ?? "Account update failed." };
      return { status: "pending" };
    }
    const account = this.records.get(did);
    if (!account || account.settings.version !== expectedVersion) return { status: "conflict" };
    let byKey = this.operations.get(did);
    if (!byKey) {
      byKey = new Map();
      this.operations.set(did, byKey);
    }
    byKey.set(key, { digest, expectedVersion, status: "pending" });
    return { status: "fresh" };
  }

  async complete(did: string, key: string, digest: string, record: AccountRecord): Promise<boolean> {
    const parsed = accountRecord.parse(record);
    if (parsed.settings.did !== did) return false;
    const operation = this.operations.get(did)?.get(key);
    if (!operation || operation.status !== "pending" || operation.digest !== digest) return false;
    if (parsed.settings.version !== operation.expectedVersion + 1) return false;
    const account = this.records.get(did);
    if (!account || account.settings.version !== operation.expectedVersion) return false;
    this.records.set(did, parsed);
    operation.result = { settings: structuredClone(parsed.settings) };
    operation.status = "completed";
    return true;
  }

  async fail(did: string, key: string, digest: string, error: string): Promise<void> {
    const operation = this.operations.get(did)?.get(key);
    if (!operation || operation.status !== "pending" || operation.digest !== digest) return;
    operation.status = "failed";
    operation.error = error;
  }
}

/** Uses the base Convex client because account settings are DID-owned, not project-workspace data. */
export class ConvexAccountStore implements AccountStore {
  constructor(
    private readonly client: ConvexHttpClient,
    private readonly secret: string,
  ) {}

  async ensure(initial: AccountRecord): Promise<AccountRecord> {
    const record = accountRecord.parse(initial);
    return decode(
      await this.client.mutation(api.accounts.ensure, {
        secret: this.secret,
        did: record.settings.did,
        json: JSON.stringify(record),
      }),
    );
  }

  async get(did: string): Promise<AccountRecord | null> {
    const json = await this.client.query(api.accounts.get, { secret: this.secret, did });
    return json === null ? null : decode(json);
  }

  async list(): Promise<AccountRecord[]> {
    return (await this.client.query(api.accounts.list, { secret: this.secret })).map(decode);
  }

  async begin(did: string, key: string, digest: string, expectedVersion: number): Promise<AccountBeginResult> {
    const result = await this.client.mutation(api.accounts.begin, {
      secret: this.secret,
      did,
      key,
      digest,
      expectedVersion,
    });
    return result.status === "completed" ? { status: "completed", record: decode(result.json) } : result;
  }

  async complete(did: string, key: string, digest: string, record: AccountRecord): Promise<boolean> {
    const parsed = accountRecord.parse(record);
    return this.client.mutation(api.accounts.complete, {
      secret: this.secret,
      did,
      key,
      digest,
      json: JSON.stringify(parsed),
    });
  }

  async fail(did: string, key: string, digest: string, error: string): Promise<void> {
    await this.client.mutation(api.accounts.fail, { secret: this.secret, did, key, digest, error });
  }
}
