import type {
  AccountSettings, KnowledgeCatalog, KnowledgeUpdate, ModelUpdate, OnboardingUpdate, RepositoryUpdate, TelemetryUpdate, PeopleUpdate,
} from "@ephyra/core";
import { KNOWLEDGE_CATALOG_FIXTURE } from "./knowledge.ts";
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

type ReadMethod = "settings" | "knowledge";
type Method = ReadMethod | "saveRepository" | "saveModel" | "saveKnowledge" | "saveTelemetry" | "savePeople" | "onboarding";
export interface FakeAccountOptions {
  initial?: AccountSettings;
  knowledgeCatalog?: KnowledgeCatalog;
  fail?: Partial<Record<Method, Error>>;
  hang?: Method[];
  /** Simulates an interrupted response after the fixture mutation has been applied. */
  uncertainAfterSave?: Exclude<Method, ReadMethod>[];
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
    method: Exclude<Method, ReadMethod>,
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
  async knowledge(): Promise<KnowledgeCatalog> {
    await this.before("knowledge");
    const enabled = this.value.knowledge?.workspaceId === this.value.workspaceId && this.value.knowledge.enabled;
    if (!enabled) return {
      ...structuredClone(KNOWLEDGE_CATALOG_FIXTURE), status: "disabled", sources: [],
      detail: "Choose whether Ephyra may use selected knowledge sources for this workspace.",
    };
    return structuredClone(this.options.knowledgeCatalog ?? {
      ...KNOWLEDGE_CATALOG_FIXTURE, status: "needs_sign_in", sources: [],
      detail: "Fictional fixture: sign in again to connect knowledge sources.",
    });
  }
  saveKnowledge(input: KnowledgeUpdate, key: string) {
    return this.update("saveKnowledge", input.expectedVersion, key, () => {
      if (input.workspaceId !== this.value.workspaceId) throw new ApiError(409, "Your workspace changed.");
      return { knowledge: {
        workspaceId: input.workspaceId, enabled: input.enabled, sources: structuredClone(input.sources),
        updatedAt: "2026-11-08T12:00:00.000Z",
      } };
    });
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
          ...(input.credentialHost ? { credentialHost: input.credentialHost } : {}),
        },
        onboarding: { status: "in_progress", updatedAt: "2026-11-07T12:00:00.000Z" },
      };
    });
  }
  saveTelemetry(input: TelemetryUpdate, key: string) {
    return this.update("saveTelemetry", input.expectedVersion, key, () => {
      if (input.workspaceId !== this.value.workspaceId) throw new ApiError(409, "Your workspace changed.");
      const previous = this.value.telemetry;
      const retained = previous?.workspaceId === input.workspaceId && previous.origin === input.origin && previous.projectId === input.projectId;
      return { telemetry: {
        enabled: input.enabled, workspaceId: input.workspaceId, provider: "posthog", origin: input.origin,
        projectId: input.projectId, includeRecordings: input.includeRecordings,
        keyConfigured: input.enabled && !input.clearKey && Boolean(input.apiKey || retained && previous?.keyConfigured),
        status: "saved", checkedAt: null, detail: "Fictional fixture. No PostHog project was contacted or verified.",
      } };
    });
  }
  savePeople(input: PeopleUpdate, key: string) {
    return this.update("savePeople", input.expectedVersion, key, () => {
      if (input.workspaceId !== this.value.workspaceId) throw new ApiError(409, "Your workspace changed.");
      const same = this.value.people?.workspaceId === input.workspaceId && this.value.people.webhookUrl === (input.webhookUrl || null);
      return { people: {
        enabled: input.enabled, workspaceId: input.workspaceId, contacts: structuredClone(input.contacts), webhookUrl: input.webhookUrl || null,
        keyConfigured: !input.clearToken && Boolean(input.token || same && this.value.people?.keyConfigured), updatedAt: "2026-11-08T12:00:00.000Z",
      } };
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
