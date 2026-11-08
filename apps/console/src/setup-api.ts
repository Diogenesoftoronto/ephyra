import { SetupRequest, SetupRun } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "./api.ts";

export interface SetupApi {
  current(signal?: AbortSignal, operationKey?: string): Promise<SetupRun | null>;
  start(input: SetupRequest, operationKey: string): Promise<SetupRun>;
}

/** Bound to the same signed-in account and repository workspace as the console. */
export class SetupClient implements SetupApi {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly workspace: string,
    private readonly principal: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(input?: SetupRequest, key?: string, signal?: AbortSignal, lookupKey?: string) {
    let response: Response;
    try {
      const fetcher = this.fetcher;
      const url = new URL("/v1/setup", this.origin);
      if (lookupKey) url.searchParams.set("operationKey", lookupKey);
      response = await fetcher(url, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          "X-Ephyra-Principal": this.principal,
          "X-Ephyra-Workspace": this.workspace,
          ...(input ? { "Content-Type": "application/json", "Idempotency-Key": key! } : {}),
        },
        ...(input ? { body: JSON.stringify(SetupRequest.parse(input)) } : {}),
      });
    } catch (error) {
      if (key) throw new UnknownWriteOutcome(key);
      if (signal?.aborted) throw error;
      throw new Error("Setup progress could not be reached.");
    }
    if (!response.ok) {
      if (key && response.status >= 500) throw new UnknownWriteOutcome(key);
      const value = await response.json().catch(() => null);
      throw new ApiError(response.status, typeof value?.error === "string" ? value.error : undefined);
    }
    try {
      return SetupRun.nullable().parse(await response.json());
    } catch {
      if (key) throw new UnknownWriteOutcome(key);
      throw new Error("Setup progress could not be read.");
    }
  }
  current(signal?: AbortSignal, operationKey?: string) { return this.request(undefined, undefined, signal, operationKey); }
  async start(input: SetupRequest, operationKey: string) {
    const run = await this.request(input, operationKey);
    if (!run || run.operationKey !== operationKey) throw new UnknownWriteOutcome(operationKey);
    return run;
  }
}
