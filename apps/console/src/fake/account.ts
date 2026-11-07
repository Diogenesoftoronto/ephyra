import type { AccountSettings, ModelUpdate, OnboardingUpdate, RepositoryUpdate } from "@ephyra/core";
import type { AccountApi } from "../account-api.ts";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import { normalizeCatalogBaseUrl, type ModelCatalog } from "../model-catalog.ts";

/** Empty public metadata fixture; screen stories never fetch the live catalog. */
export const loadAccountCatalogFixture = async (): Promise<ModelCatalog> => ({
  providers: [],
  fetchedAt: "2026-11-07T12:00:00.000Z",
  source: "https://models.dev/api.json",
});

/** Fictional Storybook data. These values do not represent a fetched repository or provider check. */
export const ACCOUNT_FIXTURE: AccountSettings = {
  did: "did:plc:storybook-account",
  version: 0,
  workspaceId: "storybook-personal-workspace",
  repository: null,
  model: {
    provider: "none",
    model: "",
    baseUrl: null,
    keyConfigured: false,
    status: "not_configured",
    checkedAt: null,
    detail: null,
  },
  onboarding: { status: "new", updatedAt: "2026-11-07T12:00:00.000Z" },
  execution: "not_configured",
};
export const CONNECTED_ACCOUNT_FIXTURE: AccountSettings = {
  ...ACCOUNT_FIXTURE,
  version: 3,
  workspaceId: "storybook-repository-workspace",
  repository: {
    url: "https://git.example.org/team/observatory.git",
    branch: "main",
    head: "abc123456789abcdef0123456789abcdef0123456",
    verifiedAt: "2026-11-07T12:00:00.000Z",
    credentialConfigured: false,
  },
  model: {
    provider: "notorganic",
    model: "storybook-model",
    baseUrl: null,
    keyConfigured: false,
    status: "needs_sign_in",
    checkedAt: null,
    detail: "Fictional fixture: model access needs your permission.",
  },
  onboarding: { status: "in_progress", updatedAt: "2026-11-07T12:00:00.000Z" },
};

type Method = "settings" | "saveRepository" | "saveModel" | "onboarding";
export interface FakeAccountOptions {
  initial?: AccountSettings;
  fail?: Partial<Record<Method, Error>>;
  hang?: Method[];
  /** Simulates an interrupted response after the fixture mutation has been applied. */
  uncertainAfterSave?: Exclude<Method, "settings">[];
}

export class FakeAccountApi implements AccountApi {
  private value: AccountSettings;
  private readonly completed = new Map<string, AccountSettings>();
  private workspaceNumber = 0;
  constructor(private readonly options: FakeAccountOptions = {}) {
    this.value = structuredClone(options.initial ?? ACCOUNT_FIXTURE);
  }
  private async before(method: Method) {
    if (this.options.hang?.includes(method)) await new Promise<never>(() => {});
    if (this.options.fail?.[method]) throw this.options.fail[method];
  }
  async settings() {
    await this.before("settings");
    return structuredClone(this.value);
  }
  private async update(
    method: Exclude<Method, "settings">,
    version: number,
    key: string,
    change: () => Partial<AccountSettings>,
  ) {
    await this.before(method);
    const prior = this.completed.get(key);
    if (prior) return structuredClone(prior);
    if (version !== this.value.version) throw new ApiError(409);
    this.value = { ...this.value, ...change(), version: this.value.version + 1 };
    this.completed.set(key, structuredClone(this.value));
    if (this.options.uncertainAfterSave?.includes(method)) throw new UnknownWriteOutcome(key);
    return structuredClone(this.value);
  }
  saveRepository(input: RepositoryUpdate, key: string) {
    return this.update("saveRepository", input.expectedVersion, key, () => {
      const same = input.url === this.value.repository?.url;
      const changed = !same || input.branch !== this.value.repository?.branch;
      return {
        workspaceId: changed ? `storybook-repository-${++this.workspaceNumber}` : this.value.workspaceId,
        repository: {
          url: input.url,
          branch: input.branch,
          head: "abc123456789abcdef0123456789abcdef0123456",
          verifiedAt: "2026-11-07T12:00:00.000Z",
          credentialConfigured: input.clearToken
            ? false
            : Boolean(input.token || (same && this.value.repository?.credentialConfigured)),
          ...(input.username ? { username: input.username } : {}),
        },
        onboarding: { status: "in_progress", updatedAt: "2026-11-07T12:00:00.000Z" },
      };
    });
  }
  saveModel(input: ModelUpdate, key: string) {
    return this.update("saveModel", input.expectedVersion, key, () => {
      const direct = input.provider !== "none" && input.provider !== "notorganic";
      const defaults = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1" };
      const baseUrl = direct
        ? normalizeCatalogBaseUrl(input.baseUrl || defaults[input.provider as keyof typeof defaults])
        : null;
      const previousBase = normalizeCatalogBaseUrl(
        this.value.model.baseUrl || defaults[this.value.model.provider as keyof typeof defaults],
      );
      const sameDestination = input.provider === this.value.model.provider && baseUrl === previousBase;
      const keyConfigured =
        direct && !input.clearKey && Boolean(input.apiKey || (sameDestination && this.value.model.keyConfigured));
      return {
        model: {
          provider: input.provider,
          model: input.model,
          baseUrl,
          keyConfigured,
          status:
            input.provider === "none"
              ? "not_configured"
              : input.provider === "notorganic"
                ? "needs_sign_in"
                : keyConfigured
                  ? "saved"
                  : "unavailable",
          checkedAt: null,
          detail: input.provider === "none" ? null : "Fictional fixture. No model or credential was checked.",
        },
        onboarding: { status: "in_progress", updatedAt: "2026-11-07T12:00:00.000Z" },
      };
    });
  }
  onboarding(input: OnboardingUpdate, key: string) {
    return this.update("onboarding", input.expectedVersion, key, () => {
      if (input.action === "complete" && !this.value.repository)
        throw new ApiError(400, "Connect a repository before completing setup, or explore first.");
      return {
        onboarding: {
          status: input.action === "skip" ? "skipped" : input.action === "complete" ? "complete" : "in_progress",
          updatedAt: "2026-11-07T12:00:00.000Z",
        },
      };
    });
  }
}
