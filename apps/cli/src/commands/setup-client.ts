import {
  AccountSettings, RepositoryUpdate, SetupRun, TelemetryProvider, type SetupMode,
} from "@ephyra/core";

/** A write may have reached the server. Only reads are safe until its receipt is reconciled. */
export class SetupWriteUnknown extends Error {
  constructor(readonly operationKey: string) {
    super(`The server has not confirmed this change. Run \`ephyra setup --interactive\` to check saved progress. Reference: ${operationKey}`);
  }
}

export class SetupApiError extends Error {
  constructor(readonly status: number) {
    const messages: Record<number, string> = {
      401: "Sign-in expired. Run `ephyra login <server-url>`, then resume setup.",
      403: "Setup needs the workspace owner's sign-in. Run `ephyra login <server-url>` with that account.",
      404: "This server does not offer account setup. Use `ephyra doctor` to check its configuration.",
      409: "Settings or setup changed elsewhere. Resume the wizard to read the saved state before making another change.",
      422: "The repository could not be verified. Check its address, branch and access in the console, then resume setup.",
    };
    super(messages[status] ?? `Setup request failed (${status}). Check the server with \`ephyra doctor\`.`);
  }
}

/** Owner session only. Every call pins the account and, after discovery, its workspace. */
export class CliSetupClient {
  workspace?: string;
  constructor(
    readonly origin: string,
    private readonly token: string,
    readonly did: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  private async request<T>(path: string, parse: (value: unknown) => T, write?: {
    method: "PUT" | "POST"; input: unknown; key: string;
  }, pinWorkspace = true): Promise<T> {
    this.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(write ? 120_000 : 30_000);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetcher(new URL(path, this.origin), {
        method: write?.method ?? "GET", signal, cache: "no-store", redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`, "X-Ephyra-Account": this.did,
          ...(pinWorkspace && this.workspace ? { "X-Ephyra-Workspace": this.workspace } : {}),
          ...(write ? { "Content-Type": "application/json", "Idempotency-Key": write.key } : {}),
        },
        ...(write ? { body: JSON.stringify(write.input) } : {}),
      });
    } catch {
      if (write) throw new SetupWriteUnknown(write.key);
      this.signal?.throwIfAborted();
      throw new Error("Setup could not be reached. Check the address and network, then resume the wizard.");
    }
    if (!res.ok) {
      if (write && res.status >= 500) throw new SetupWriteUnknown(write.key);
      throw new SetupApiError(res.status);
    }
    try { return parse(await res.json()); }
    catch {
      if (write) throw new SetupWriteUnknown(write.key);
      this.signal?.throwIfAborted();
      throw new Error("The server returned unreadable setup progress. Check `ephyra doctor` before trying again.");
    }
  }

  private account(value: unknown) {
    const settings = AccountSettings.parse(value);
    if (settings.did !== this.did) throw new Error("Account changed");
    this.workspace = settings.workspaceId;
    return settings;
  }
  settings(refreshRepository = false) {
    return this.request("/v1/account", value => this.account(value), undefined, !refreshRepository);
  }
  saveRepository(input: RepositoryUpdate, key: string) {
    return this.request("/v1/account/repository", value => this.account(value), {
      method: "PUT", input: RepositoryUpdate.parse(input), key,
    });
  }
  detectedTelemetry() {
    return this.request("/v1/account/telemetry/detected", value => {
      const providers = (value as { providers?: unknown })?.providers;
      if (!Array.isArray(providers)) throw new Error("Unreadable discovery");
      return providers.map(provider => TelemetryProvider.parse(provider));
    });
  }
  current(key?: string) {
    return this.request(`/v1/setup${key ? `?operationKey=${encodeURIComponent(key)}` : ""}`, value => {
      const run = SetupRun.nullable().parse(value);
      if (key && run && run.operationKey !== key) throw new Error("Mismatched operation receipt");
      return run;
    });
  }
  async start(mode: SetupMode, key: string) {
    const run = await this.request("/v1/setup", value => SetupRun.parse(value), {
      method: "POST", input: { mode }, key,
    });
    if (run.operationKey !== key) throw new SetupWriteUnknown(key);
    return run;
  }
}
