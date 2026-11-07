import { AccountSettings, type RepositoryUpdate, type ModelUpdate, type OnboardingUpdate } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "./api.ts";

export interface AccountApi {
  settings(): Promise<AccountSettings>;
  saveRepository(input: RepositoryUpdate, operationKey: string): Promise<AccountSettings>;
  saveModel(input: ModelUpdate, operationKey: string): Promise<AccountSettings>;
  onboarding(input: OnboardingUpdate, operationKey: string): Promise<AccountSettings>;
}

export class AccountClient implements AccountApi {
  constructor(
    private readonly origin: string,
    private readonly token = "",
    private readonly fetcher: typeof fetch = fetch,
    private readonly did?: string,
  ) {}
  private async request(path: string, input?: unknown, operationKey?: string): Promise<AccountSettings> {
    const fetcher = this.fetcher;
    let response: Response;
    try {
      response = await fetcher(new URL(`/v1/account${path}`, this.origin), {
        method: input === undefined ? "GET" : "PUT",
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
      return AccountSettings.parse(await response.json());
    } catch {
      if (operationKey) throw new UnknownWriteOutcome(operationKey);
      throw new Error("Account settings could not be read.");
    }
  }
  settings() {
    return this.request("");
  }
  saveRepository(input: RepositoryUpdate, key: string) {
    return this.request("/repository", input, key);
  }
  saveModel(input: ModelUpdate, key: string) {
    return this.request("/model", input, key);
  }
  onboarding(input: OnboardingUpdate, key: string) {
    return this.request("/onboarding", input, key);
  }
}
