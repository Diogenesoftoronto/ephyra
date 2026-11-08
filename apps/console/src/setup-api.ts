import { BootstrapResponse, SetupRequest, SetupRun } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "./api.ts";

export interface SetupApi {
  current(signal?: AbortSignal, operationKey?: string): Promise<SetupRun | null>;
  record?(setupId: string): Promise<SetupRun | null>;
  start(input: SetupRequest, operationKey: string): Promise<SetupRun>;
  reassess?(operationKey: string): Promise<SetupRun | null>;
  respond?(input: BootstrapResponse, operationKey: string): Promise<SetupRun>;
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

  private async request(options: {
    path?: string; input?: unknown; key?: string; signal?: AbortSignal; lookupKey?: string;
  } = {}) {
    const { input, key, signal, lookupKey } = options;
    let response: Response;
    try {
      const fetcher = this.fetcher;
      const url = new URL(options.path ?? "/v1/setup", this.origin);
      if (lookupKey) url.searchParams.set("operationKey", lookupKey);
      response = await fetcher(url, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          "X-Ephyra-Principal": this.principal,
          "X-Ephyra-Account": this.principal,
          "X-Ephyra-Workspace": this.workspace,
          ...(input ? { "Content-Type": "application/json", "Idempotency-Key": key! } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
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
  current(signal?: AbortSignal, operationKey?: string) { return this.request({ signal, lookupKey: operationKey }); }
  async record(setupId: string) {
    if (!/^[a-f0-9]{32}$/.test(setupId)) throw new Error("Invalid setup record.");
    const run = await this.request({ path: `/v1/setup/runs/${setupId}` });
    if (run && run.id !== setupId) throw new Error("The setup record did not match its reference.");
    return run;
  }
  async start(input: SetupRequest, operationKey: string) {
    const run = await this.request({ input: SetupRequest.parse(input), key: operationKey });
    if (!run || run.operationKey !== operationKey) throw new UnknownWriteOutcome(operationKey);
    return run;
  }
  reassess(operationKey: string) {
    return this.request({ path: "/v1/setup/bootstrap/reassess", input: {}, key: operationKey });
  }
  async respond(input: BootstrapResponse, operationKey: string) {
    const value = BootstrapResponse.parse(input);
    const run = await this.request({ path: "/v1/setup/bootstrap/answer", input: value, key: operationKey });
    const answer = run?.bootstrap?.requests.find((request) => request.id === value.requestId)?.answer;
    if (!run || run.id !== value.setupId || run.repository.head !== value.head || run.bootstrap?.setupId !== value.setupId
      || run.bootstrap.head !== value.head || answer?.operationKey !== operationKey)
      throw new UnknownWriteOutcome(operationKey);
    return run;
  }
}
