import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import {
  AccountSettings,
  Unverified,
  type ModelUpdate,
  type RepositoryUpdate,
  type OnboardingUpdate,
} from "@ephyra/core";
import { redact } from "@ephyra/agent";
import type { SecretBox, Fetch } from "../auth/crypto.ts";
import type { NotOrganicSignIn } from "../auth/notorganic.ts";
import { AnthropicDraftModel, OpenAiDraftModel, NotOrganicDraftModel, type DraftModel } from "../velum.ts";
import { canonicalJson } from "../audit.ts";
import type { AccountRecord, AccountStore } from "./account-store.ts";
import { ConnectionError, parsePublicHttps, publicHttpsFetch } from "./network.ts";
import { RepositoryConnector } from "./repository.ts";

export class AccountError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}
export type AccountOptions = {
  store: AccountStore;
  box: SecretBox;
  operationSecret: string;
  dataDir: string;
  signIn: NotOrganicSignIn;
  repository?: Pick<RepositoryConnector, "prepare">;
  fetcher?: Fetch;
  onWorkspaceChange?: (before: string, after: string) => void;
};

export function workspaceId(did: string, url = "", branch = ""): string {
  return `ws_${createHash("sha256")
    .update(JSON.stringify([did, url, branch]))
    .digest("hex")
    .slice(0, 40)}`;
}
export function initialAccount(did: string): AccountRecord {
  return {
    settings: {
      did,
      version: 0,
      workspaceId: workspaceId(did),
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
      onboarding: { status: "new", updatedAt: new Date().toISOString() },
      execution: "not_configured",
    },
  };
}

/** Account identity comes exclusively from the authenticated Not Organic principal. Keys are write-only. */
export class Accounts {
  private readonly repository;
  private readonly fetcher;
  constructor(readonly options: AccountOptions) {
    this.repository = options.repository ?? new RepositoryConnector();
    this.fetcher = options.fetcher ?? publicHttpsFetch;
  }
  directory(id: string): string {
    if (!/^ws_[a-f0-9]{40}$/.test(id)) throw new AccountError(400, "Invalid workspace.");
    return join(this.options.dataDir, "workspaces", id);
  }
  async record(did: string) {
    return this.options.store.ensure(initialAccount(did));
  }
  async public(record: AccountRecord): Promise<AccountSettings> {
    const result = AccountSettings.parse(record.settings);
    if (result.model.provider === "notorganic") {
      const ready = await this.options.signIn.hasScope(result.did, `infer:${result.model.model}`);
      result.model.status = ready ? "saved" : "needs_sign_in";
      result.model.detail = ready
        ? "Your Not Organic account will pay for model requests."
        : "Sign in again to allow this model on your account.";
    }
    return result;
  }
  async settings(did: string) {
    return this.public(await this.record(did));
  }
  async scopes(did: string): Promise<string[]> {
    const record = await this.options.store.get(did);
    return record?.settings.model.provider === "notorganic" ? [`infer:${record.settings.model.model}`] : [];
  }
  private async change(
    did: string,
    key: string,
    operation: string,
    input: { expectedVersion: number },
    update: (record: AccountRecord) => Promise<AccountRecord>,
  ): Promise<AccountSettings> {
    if (!/^[A-Za-z0-9:._-]{8,160}$/.test(key)) throw new AccountError(400, "A valid operation key is required.");
    const current = await this.record(did);
    // A keyed digest prevents a leaked receipt from becoming an offline API-key guessing oracle.
    const digest = createHmac("sha256", this.options.operationSecret)
      .update(canonicalJson({ did, operation, input }))
      .digest("hex");
    const begun = await this.options.store.begin(did, key, digest, input.expectedVersion);
    if (begun.status === "completed") return this.public(begun.record);
    if (begun.status === "failed") throw new AccountError(422, begun.error);
    if (begun.status === "pending")
      throw new AccountError(
        409,
        "This save has an uncertain outcome. Refresh the saved settings before making another change.",
      );
    if (begun.status === "conflict" || current.settings.version !== input.expectedVersion) {
      throw new AccountError(409, "Settings changed in another tab. Refresh before saving again.");
    }
    let next: AccountRecord;
    try {
      next = await update(structuredClone(current));
      next.settings.version = current.settings.version + 1;
      next.settings.onboarding.updatedAt = new Date().toISOString();
      if (next.settings.onboarding.status === "new") next.settings.onboarding.status = "in_progress";
    } catch (error) {
      const message =
        error instanceof AccountError || error instanceof ConnectionError
          ? error.message
          : "Setup could not be verified. Check the connection and try again.";
      await this.options.store.fail(did, key, digest, message);
      throw new AccountError(error instanceof AccountError ? error.status : 422, message);
    }
    // Do not turn an ambiguous database response into a failed receipt, or repeat the mutation automatically.
    if (!(await this.options.store.complete(did, key, digest, next))) {
      throw new AccountError(409, "Settings changed while saving. Refresh to see the saved configuration.");
    }
    if (current.settings.workspaceId !== next.settings.workspaceId)
      this.options.onWorkspaceChange?.(current.settings.workspaceId, next.settings.workspaceId);
    return this.public(next);
  }
  async saveRepository(did: string, input: RepositoryUpdate, key: string) {
    return this.change(did, key, "repository", input, async (record) => {
      if (input.token && input.clearToken)
        throw new AccountError(400, "Choose a replacement token or remove the token.");
      const url = parsePublicHttps(input.url).href;
      if (new URL(url).search) throw new AccountError(400, "Repository URLs cannot contain query parameters.");
      const branch = input.branch.replace(/^refs\/heads\//, "");
      const previous = record.settings.repository;
      const sameRepository = previous?.url === url;
      const token =
        input.token ??
        (!input.clearToken && sameRepository && record.repoToken
          ? await this.options.box.open<string>(record.repoToken)
          : undefined);
      const username = input.username || (sameRepository ? previous?.username : undefined);
      const id = workspaceId(did, url, branch);
      const verified = await this.repository.prepare(
        { url, branch, ...(username ? { username } : {}), ...(token ? { token } : {}) },
        this.directory(id),
      );
      record.settings.workspaceId = id;
      record.settings.repository = {
        ...verified,
        credentialConfigured: Boolean(token),
        ...(username ? { username } : {}),
      };
      if (token) record.repoToken = await this.options.box.seal(token);
      else delete record.repoToken;
      return record;
    });
  }
  async saveModel(did: string, input: ModelUpdate, key: string) {
    return this.change(did, key, "model", input, async (record) => {
      if (input.apiKey && input.clearKey) throw new AccountError(400, "Choose a replacement key or remove the key.");
      if (input.provider !== "none" && !/^[^\s\u0000-\u001f]{1,200}$/.test(input.model))
        throw new AccountError(400, "Enter a model identifier.");
      const defaults = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1" };
      const byok = ["openai", "anthropic", "compatible"].includes(input.provider);
      const baseUrl = byok
        ? parsePublicHttps(input.baseUrl || defaults[input.provider as keyof typeof defaults] || "").href.replace(
            /\/$/,
            "",
          )
        : null;
      if (baseUrl && new URL(baseUrl).search)
        throw new AccountError(400, "The provider URL cannot contain query parameters.");
      const sameDestination =
        record.settings.model.provider === input.provider && record.settings.model.baseUrl === baseUrl;
      const apiKey = byok
        ? (input.apiKey ??
          (!input.clearKey && sameDestination && record.modelKey
            ? await this.options.box.open<string>(record.modelKey)
            : undefined))
        : undefined;
      const model: AccountSettings["model"] = {
        provider: input.provider,
        model: input.provider === "none" ? "" : input.model,
        baseUrl,
        keyConfigured: Boolean(apiKey),
        status: "not_configured",
        checkedAt: null,
        detail: null,
      };
      if (input.provider === "notorganic") model.status = "saved";
      else if (byok && apiKey) {
        const response = await this.fetcher(`${baseUrl}/models`, {
          method: "GET",
          signal: AbortSignal.timeout(15_000),
          headers:
            input.provider === "anthropic"
              ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
              : { authorization: `Bearer ${apiKey}` },
        });
        if ([401, 403].includes(response.status))
          throw new AccountError(422, "The provider did not accept this key. Check its permissions and endpoint.");
        if (response.status >= 500 || response.status === 429)
          throw new AccountError(
            422,
            "The provider is unavailable or rate limited. The previous settings are unchanged.",
          );
        const body = response.ok
          ? ((await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null)
          : null;
        const found = Array.isArray(body?.data) && body.data.some((item) => item?.id === input.model);
        model.status = found ? "verified" : "saved";
        model.checkedAt = new Date().toISOString();
        model.detail = found
          ? "Key accepted and model listed. No generation was run."
          : "Saved. This endpoint did not confirm the model. No generation was run.";
      } else if (byok) model.detail = "Add a key to use this model.";
      record.settings.model = model;
      if (apiKey) record.modelKey = await this.options.box.seal(apiKey);
      else delete record.modelKey;
      return record;
    });
  }
  async onboarding(did: string, input: OnboardingUpdate, key: string) {
    return this.change(did, key, "onboarding", input, async (record) => {
      if (input.action === "complete" && !record.settings.repository)
        throw new AccountError(400, "Connect a repository first, or skip setup for now.");
      record.settings.onboarding.status =
        input.action === "complete" ? "complete" : input.action === "skip" ? "skipped" : "in_progress";
      return record;
    });
  }
  /** Capture the selection once per request, so concurrent settings edits cannot misattribute a reply or charge. */
  async modelFor(did: string, workspace: string): Promise<DraftModel | null> {
    const record = await this.record(did);
    if (record.settings.workspaceId !== workspace)
      throw new Unverified("This workspace is no longer selected. Open the current workspace.");
    const { model } = record.settings;
    if (model.provider === "none") return null;
    if (model.provider === "notorganic") {
      if (!(await this.options.signIn.hasScope(did, `infer:${model.model}`)))
        throw new Unverified("Allow the selected hosted model in Settings by signing in again.");
      return new NotOrganicDraftModel(this.options.signIn, did, model.model);
    }
    if (!record.modelKey || !model.baseUrl) return null;
    const apiKey = await this.options.box.open<string>(record.modelKey);
    const adapter =
      model.provider === "anthropic"
        ? new AnthropicDraftModel(apiKey, model.model, this.fetcher, `${model.baseUrl}/messages`)
        : new OpenAiDraftModel(
            apiKey,
            model.model,
            this.fetcher,
            `${model.baseUrl}/chat/completions`,
            model.provider === "openai" ? "max_completion_tokens" : "max_tokens",
          );
    return {
      kind: adapter.kind,
      billedTo: adapter.billedTo,
      requestedModel: adapter.requestedModel,
      complete: async (request) => {
        try {
          const result = await adapter.complete({
            ...request,
            system: redact(request.system, [apiKey], 150_000),
            messages: request.messages.map((m) => ({ ...m, content: redact(m.content, [apiKey], 150_000) })),
          });
          return {
            ...result,
            text: redact(result.text, [apiKey], 150_000),
            engine: redact(result.engine, [apiKey], 200),
          };
        } catch (error) {
          if (error instanceof Unverified) throw new Unverified(redact(error.message, [apiKey], 300));
          throw new Unverified("The selected provider could not complete this request.");
        }
      },
    };
  }
}
