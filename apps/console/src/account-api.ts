import {
  AccountSettings, KnowledgeCatalog, type KnowledgeUpdate, type RepositoryUpdate, type ModelUpdate, type OnboardingUpdate,
  type TelemetryUpdate, type PeopleUpdate, type MirrorUpdate, type MirrorRemove,
} from "@ephyra/core";
import { z } from "zod";
import { ApiError, UnknownWriteOutcome } from "./api.ts";

export interface AccountApi {
  settings(): Promise<AccountSettings>;
  knowledge(): Promise<KnowledgeCatalog>;
  saveKnowledge(input: KnowledgeUpdate, operationKey: string): Promise<AccountSettings>;
  saveTelemetry(input: TelemetryUpdate, operationKey: string): Promise<AccountSettings>;
  savePeople(input: PeopleUpdate, operationKey: string): Promise<AccountSettings>;
  saveRepository(input: RepositoryUpdate, operationKey: string): Promise<AccountSettings>;
  saveModel(input: ModelUpdate, operationKey: string): Promise<AccountSettings>;
  saveMirror(input: MirrorUpdate, operationKey: string): Promise<AccountSettings>;
  removeMirror(input: MirrorRemove, operationKey: string): Promise<AccountSettings>;
  onboarding(input: OnboardingUpdate, operationKey: string): Promise<AccountSettings>;
}

export class AccountClient implements AccountApi {
  constructor(
    private readonly origin: string,
    private readonly token = "",
    private readonly fetcher: typeof fetch = fetch,
    private readonly did?: string,
  ) {}
  private async request<T>(
    path: string, schema: z.ZodType<T>, input?: unknown, operationKey?: string, method: "PUT" | "POST" = "PUT",
  ): Promise<T> {
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(new URL(`/v1/account${path}`, this.origin), {
        method: input === undefined ? "GET" : method,
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(this.did ? { "X-Ephyra-Account": this.did } : {}),
          ...(input === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": operationKey! }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    } catch {
      if (operationKey) throw new UnknownWriteOutcome(operationKey);
      throw new Error("Account settings could not be reached.");
    }
    if (!response.ok) {
      if (operationKey && response.status >= 500) throw new UnknownWriteOutcome(operationKey);
      const body = await response.json().catch(() => null);
      throw new ApiError(response.status, typeof body?.error === "string" ? body.error : undefined);
    }
    try {
      return schema.parse(await response.json());
    } catch {
      if (operationKey) throw new UnknownWriteOutcome(operationKey);
      throw new Error("Account settings could not be read.");
    }
  }
  settings() {
    return this.request("", AccountSettings);
  }
  knowledge() {
    return this.request("/knowledge", KnowledgeCatalog);
  }
  saveKnowledge(input: KnowledgeUpdate, key: string) {
    return this.request("/knowledge", AccountSettings, input, key);
  }
  saveTelemetry(input: TelemetryUpdate, key: string) {
    return this.request("/telemetry", AccountSettings, input, key);
  }
  savePeople(input: PeopleUpdate, key: string) {
    return this.request("/people", AccountSettings, input, key);
  }
  saveRepository(input: RepositoryUpdate, key: string) {
    return this.request("/repository", AccountSettings, input, key);
  }
  saveModel(input: ModelUpdate, key: string) {
    return this.request("/model", AccountSettings, input, key);
  }
  saveMirror(input: MirrorUpdate, key: string) {
    return this.request("/mirrors", AccountSettings, input, key);
  }
  removeMirror(input: MirrorRemove, key: string) {
    return this.request("/mirrors/remove", AccountSettings, input, key, "POST");
  }
  onboarding(input: OnboardingUpdate, key: string) {
    return this.request("/onboarding", AccountSettings, input, key);
  }
}
