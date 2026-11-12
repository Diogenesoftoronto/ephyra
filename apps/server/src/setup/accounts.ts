import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import {
  AccountSettings,
  IsoTime,
  Unverified,
  type ModelUpdate,
  type RepositoryUpdate,
  type OnboardingUpdate,
  type KnowledgeUpdate,
  type KnowledgeCatalog,
  type KnowledgeSelection,
  type TelemetryUpdate,
  type PeopleUpdate,
  type LandingReceipt,
  type MirrorRemove,
  type MirrorUpdate,
  type AgentRole,
  type RoleModelUpdate,
} from "@ephyra/core";
import { parseRepositoryAddress } from "@ephyra/forge";
import { redact } from "@ephyra/agent";
import { PostHogEvidence } from "@ephyra/evidence";
import type { SecretBox, Fetch } from "../auth/crypto.ts";
import type { NotOrganicSignIn } from "../auth/notorganic.ts";
import { NotOrganicKnowledge, KnowledgeAccessError } from "../auth/knowledge.ts";
import { AnthropicDraftModel, OpenAiDraftModel, NotOrganicDraftModel, type DraftModel } from "../velum.ts";
import { canonicalJson } from "../audit.ts";
import type { AccountRecord, AccountStore } from "./account-store.ts";
import { ConnectionError, parsePublicHttps, publicHttpsFetch, resolvePublicHttps } from "./network.ts";
import { RepositoryConnector } from "./repository.ts";
import { ForgeRepositoryConnector, type ForgeResolution, type ForgeRepositoryInput } from "./forge-repository.ts";
import { ownerContact } from "./questions.ts";
import { installationToken, verifyInstallation, type GitHubAppConfig } from "./github-app.ts";
import { redactModelText } from "./model-redaction.ts";

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
  repository?: Pick<RepositoryConnector, "prepare"> & Partial<Pick<RepositoryConnector, "discover" | "command">>
    & { resolve?: (input: ForgeRepositoryInput) => Promise<ForgeResolution> };
  fetcher?: Fetch;
  onWorkspaceChange?: (before: string, after: string) => void;
  automation?: (did: string) => AccountSettings["automation"];
  /** Feature flag: set when the deployment has a GitHub App. Mints per-repository installation tokens. */
  githubApp?: GitHubAppConfig | null;
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
  readonly knowledgeGateway: NotOrganicKnowledge;
  constructor(readonly options: AccountOptions) {
    this.repository = options.repository ?? new ForgeRepositoryConnector();
    this.fetcher = options.fetcher ?? publicHttpsFetch;
    this.knowledgeGateway = new NotOrganicKnowledge(options.signIn);
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
    result.automation = this.options.automation?.(result.did);
    result.people ??= { enabled: true, workspaceId: result.workspaceId, contacts: [ownerContact(result.did)],
      webhookUrl: null, keyConfigured: false, updatedAt: result.onboarding.updatedAt };
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
  async repositoryCommand(did: string, workspace: string, argv: string[]) {
    const record = await this.record(did);
    const repository = record.settings.repository;
    if (record.settings.workspaceId !== workspace || !repository || !this.repository.command)
      throw new AccountError(409, "The repository authority changed or its write transport is unavailable.");
    const input = { url: repository.url, branch: repository.branch, username: repository.username,
      credentialHost: repository.credentialHost, token: await this.repositoryCredential(record) };
    const result = await this.repository.command(input, this.directory(workspace), argv);
    const fresh = await this.record(did);
    if (fresh.settings.workspaceId !== workspace || canonicalJson(fresh.settings.repository) !== canonicalJson(repository)
      || fresh.repoToken !== record.repoToken) throw new AccountError(409, "Repository authority changed during the operation.");
    return result;
  }
  /** The credential for git and forge API calls: a fresh GitHub App installation token, else the saved token. */
  private async repositoryCredential(record: AccountRecord): Promise<string | undefined> {
    const repository = record.settings.repository;
    const app = this.options.githubApp;
    if (repository?.githubApp && app && repository.forge?.kind === "github") {
      const path = new URL(repository.forge.cloneUrl ?? repository.url).pathname.replace(/^\/|\.git$/g, "");
      return installationToken(app, repository.githubApp.installationId, path, this.fetcher);
    }
    return record.repoToken ? this.options.box.open<string>(record.repoToken) : undefined;
  }
  /** The repository credential, opened for one forge API call. Refuses if the workspace or repository changed. */
  async repositoryToken(did: string, workspace: string, expected: AccountSettings["repository"]): Promise<string> {
    const record = await this.record(did);
    if (record.settings.workspaceId !== workspace || canonicalJson(record.settings.repository) !== canonicalJson(expected))
      throw new AccountError(409, "The repository authority changed.");
    const credential = await this.repositoryCredential(record);
    if (!credential) throw new AccountError(409, "Connect with GitHub, or save a repository token, to open pull requests.");
    return credential;
  }
  /** Bind a GitHub App installation to the workspace repository after GitHub confirms it covers that repository. */
  async connectGitHubApp(did: string, installationId: string, key: string) {
    const app = this.options.githubApp;
    if (!app) throw new AccountError(409, "This server has no GitHub App configured.");
    const record = await this.record(did);
    const repository = record.settings.repository;
    if (!repository || repository.forge?.kind !== "github") throw new AccountError(409, "Connect a GitHub repository first.");
    const path = new URL(repository.forge.cloneUrl ?? repository.url).pathname.replace(/^\/|\.git$/g, "");
    const verified = await verifyInstallation(app, installationId, path, this.fetcher).catch((error: unknown) => {
      throw new AccountError(422, error instanceof Error ? error.message : "GitHub did not confirm the installation.");
    });
    return this.change(did, key, "github-app", { expectedVersion: record.settings.version, installationId } as { expectedVersion: number }, async (next) => {
      const bare = (r: NonNullable<AccountSettings["repository"]> | null) => { if (!r) return null; const { githubApp: _, ...rest } = r; return rest; };
      if (canonicalJson(bare(next.settings.repository)) !== canonicalJson(bare(repository)))
        throw new AccountError(409, "The repository changed. Connect with GitHub again.");
      next.settings.repository = { ...next.settings.repository!, credentialConfigured: true,
        githubApp: { installationId: verified.installationId, account: verified.account, connectedAt: new Date().toISOString() } };
      return next;
    });
  }
  async refreshRepository(did: string, workspace: string): Promise<string> {
    const record = await this.record(did);
    const repository = record.settings.repository;
    if (record.settings.workspaceId !== workspace || !repository) throw new AccountError(409, "The workspace repository changed.");
    const result = await this.repository.prepare({ url: repository.url, branch: repository.branch, username: repository.username,
      credentialHost: repository.credentialHost, token: await this.repositoryCredential(record) },
    this.directory(workspace));
    const fresh = await this.record(did);
    if (fresh.settings.workspaceId !== workspace || canonicalJson(fresh.settings.repository) !== canonicalJson(repository))
      throw new AccountError(409, "Repository authority changed while refreshing its base.");
    return result.head;
  }
  async deploymentFor(did: string, workspace: string, expected: string) {
    const record = await this.record(did);
    const config = record.settings.telemetry;
    const repository = record.settings.repository;
    if (record.settings.workspaceId !== workspace || !config?.enabled || config.workspaceId !== workspace
      || !config.deploymentUrl || !repository) return null;
    const response = await this.fetcher(config.deploymentUrl, {
      method: "GET", redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Unverified("deployment receipt endpoint");
    const text = await response.text();
    if (Buffer.byteLength(text) > 16_000) throw new Unverified("bounded deployment receipt");
    let value: Record<string, unknown>;
    try { value = JSON.parse(text); } catch { throw new Unverified("deployment receipt JSON"); }
    const at = typeof value?.deployedAt === "string" ? Date.parse(value.deployedAt) : NaN;
    if (value?.schema !== 1 || value.repository !== repository.url
      || value.branch !== repository.branch.replace(/^refs\/heads\//, "")
      || typeof value.commit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.commit)
      || !IsoTime.safeParse(value.deployedAt).success || !Number.isFinite(at) || at > Date.now() + 5000)
      throw new Unverified("deployment receipt repository and branch binding");
    const fresh = await this.record(did);
    if (fresh.settings.workspaceId !== workspace || canonicalJson(fresh.settings.telemetry) !== canonicalJson(config)
      || canonicalJson(fresh.settings.repository) !== canonicalJson(repository)) throw new Unverified("deployment source authority changed");
    return value.commit === expected ? { sha: value.commit, deployedAt: value.deployedAt as string,
      observedAt: new Date().toISOString(), source: config.deploymentUrl } : null;
  }
  async scopes(did: string): Promise<string[]> {
    const record = await this.options.store.get(did);
    return [
      ...(record?.settings.model.provider === "notorganic" ? [`infer:${record.settings.model.model}`] : []),
      ...(record?.settings.knowledge?.enabled ? ["knowledge:read", "knowledge:tools"] : []),
    ];
  }
  async knowledge(did: string): Promise<KnowledgeCatalog> {
    const record = await this.record(did);
    const manage = new URL("/", this.options.signIn.config.authorizationUrl);
    manage.searchParams.set("view", "knowledge");
    manage.searchParams.set("app_client", this.options.signIn.config.publicOrigin);
    manage.searchParams.set("return_to", `${this.options.signIn.config.publicOrigin}/app/#/onboarding`);
    const links = { manageUrl: manage.href, authorizeUrl: "/auth/login?setup=1" };
    if (!record.settings.knowledge?.enabled) return {
      ...links, status: "disabled", sources: [], detail: "Connect the knowledge sources you want Ephyra to use during research.",
    };
    const allowed = await Promise.all(["knowledge:read", "knowledge:tools"].map((scope) => this.options.signIn.hasScope(did, scope)));
    if (allowed.some((value) => !value)) return {
      ...links, status: "needs_sign_in", sources: [], detail: "Allow Ephyra to access the connections you share from Not Organic.",
    };
    try {
      return { ...links, status: "available", sources: await this.knowledgeGateway.sources(did),
        detail: "Choose sources for automatic research. Manage their access in your Not Organic account." };
    } catch (error) {
      return { ...links, status: error instanceof KnowledgeAccessError && error.status === "needs_sign_in" ? "needs_sign_in" : "unavailable",
        sources: [], detail: "Knowledge connections could not be checked. Refresh to try again, or manage access in Not Organic." };
    }
  }
  async saveKnowledge(did: string, input: KnowledgeUpdate, key: string) {
    return this.change(did, key, "knowledge", input, async (record) => {
      if (input.workspaceId !== record.settings.workspaceId)
        throw new AccountError(409, "Your workspace changed. Reload before choosing knowledge sources.");
      if (!input.enabled && input.sources.length) throw new AccountError(400, "Remove sources when disconnecting knowledge.");
      if (input.sources.length) {
        const catalog = await this.knowledge(did);
        if (catalog.status !== "available") throw new AccountError(422, "Allow knowledge access and refresh the available sources before saving.");
        for (const selection of input.sources) {
          const source = catalog.sources.find((item) => item.id === selection.id);
          if (!source || selection.resources && !source.resourcesAllowed)
            throw new AccountError(422, "A selected source is no longer shared with Ephyra. Refresh its access before saving.");
          if (selection.searchTool && !source.tools.some((tool) => tool.queryField !== null
            && tool.name === selection.searchTool!.name && tool.queryField === selection.searchTool!.queryField
            && tool.definitionHash === selection.searchTool!.definitionHash))
            throw new AccountError(422, "A selected research tool changed or is unavailable. Refresh and choose it again.");
        }
      }
      record.settings.knowledge = {
        enabled: input.enabled, workspaceId: record.settings.workspaceId, sources: input.sources,
        updatedAt: new Date().toISOString(),
      };
      return record;
    });
  }
  async saveTelemetry(did: string, input: TelemetryUpdate, key: string) {
    return this.change(did, key, "telemetry", input, async (record) => {
      if (input.workspaceId !== record.settings.workspaceId) throw new AccountError(409, "Your workspace changed. Reload before saving telemetry.");
      if (input.apiKey && input.clearKey) throw new AccountError(400, "Replace the key or remove it.");
      const origin = input.enabled ? parsePublicHttps(input.origin).origin : "";
      const previous = record.settings.telemetry;
      const retained = previous?.origin === origin && previous.projectId === input.projectId && previous.workspaceId === input.workspaceId;
      const deploymentUrl = input.enabled ? (input.deploymentUrl === undefined && retained
        ? previous.deploymentUrl : input.deploymentUrl?.trim() || undefined) : undefined;
      if (deploymentUrl) {
        const parsed = parsePublicHttps(deploymentUrl);
        if (parsed.search || parsed.hash) throw new AccountError(400, "Use a public HTTPS deployment receipt URL without a query or fragment.");
        await resolvePublicHttps(deploymentUrl);
      }
      if (input.enabled && (!/^\d+$/.test(input.projectId) || new URL(input.origin).pathname.replace(/\/$/, "")))
        throw new AccountError(400, "Enter the PostHog origin and numeric project ID.");
      const secret = input.apiKey ?? (!input.clearKey && retained && record.telemetryKey
        ? await this.options.box.open<string>(record.telemetryKey) : undefined);
      if (input.enabled && !secret) throw new AccountError(400, "A PostHog personal API key with project read access is required.");
      let checkedAt: string | null = null;
      if (input.enabled) {
        const source = new PostHogEvidence({ origin, projectId: input.projectId, scope: { accountId: did, workspaceId: input.workspaceId },
          credential: async () => secret!, authorize: async () => true, fetcher: this.fetcher, includeRecordings: input.includeRecordings });
        await source.exceptions(new Date(Date.now() - 60_000).toISOString());
        checkedAt = new Date().toISOString();
      }
      record.settings.telemetry = { enabled: input.enabled, workspaceId: input.workspaceId, provider: "posthog", origin,
        ...(deploymentUrl ? { deploymentUrl } : {}),
        projectId: input.projectId, keyConfigured: Boolean(input.enabled && secret), includeRecordings: input.includeRecordings,
        status: input.enabled ? "verified" : "saved", checkedAt,
        detail: input.enabled ? "Project access checked. Ephyra polls observed exceptions and uses them during research."
          : "PostHog is disconnected." };
      if (input.enabled && secret) record.telemetryKey = await this.options.box.seal(secret);
      else delete record.telemetryKey;
      return record;
    });
  }
  async telemetryFor(did: string, workspace: string): Promise<PostHogEvidence | null> {
    const record = await this.options.store.get(did);
    const config = record?.settings.telemetry;
    if (record?.settings.workspaceId !== workspace || !config?.enabled || config.workspaceId !== workspace || !record.telemetryKey) return null;
    const allowed = async () => {
      const fresh = await this.options.store.get(did);
      return Boolean(fresh?.settings.workspaceId === workspace && fresh.telemetryKey === record.telemetryKey
        && canonicalJson(fresh.settings.telemetry) === canonicalJson(config));
    };
    return new PostHogEvidence({ origin: config.origin, projectId: config.projectId, scope: { accountId: did, workspaceId: workspace },
      authorize: allowed, credential: async () => await allowed() ? this.options.box.open<string>(record.telemetryKey!) : null,
      fetcher: this.fetcher, includeRecordings: config.includeRecordings });
  }
  async savePeople(did: string, input: PeopleUpdate, key: string) {
    return this.change(did, key, "people", input, async (record) => {
      if (input.workspaceId !== record.settings.workspaceId) throw new AccountError(409, "Your workspace changed. Reload before saving contacts.");
      if (input.token && input.clearToken) throw new AccountError(400, "Replace the delivery token or remove it.");
      const webhookUrl = input.webhookUrl ? parsePublicHttps(input.webhookUrl).href : null;
      const token = input.token ?? (!input.clearToken && webhookUrl === record.settings.people?.webhookUrl && record.peopleToken
        ? await this.options.box.open<string>(record.peopleToken) : undefined);
      if (input.enabled && input.contacts.some((contact) => contact.did !== did) && (!webhookUrl || !token))
        throw new AccountError(400, "Other recipients need an authenticated delivery bridge.");
      record.settings.people = { enabled: input.enabled, workspaceId: input.workspaceId, contacts: input.contacts,
        webhookUrl, keyConfigured: Boolean(token), updatedAt: new Date().toISOString() };
      if (token) record.peopleToken = await this.options.box.seal(token);
      else delete record.peopleToken;
      return record;
    });
  }
  async peopleFor(did: string, workspace: string) {
    const record = await this.options.store.get(did);
    if (!record || record.settings.workspaceId !== workspace) return null;
    const settings = record.settings.people ?? { enabled: true, workspaceId: workspace, contacts: [ownerContact(did)],
      webhookUrl: null, keyConfigured: false, updatedAt: record.settings.onboarding.updatedAt };
    if (!settings.enabled || settings.workspaceId !== workspace) return null;
    return { settings, ...(record.peopleToken ? { token: await this.options.box.open<string>(record.peopleToken) } : {}) };
  }
  /** Re-read local authority before each upstream call and before returning source content. */
  async knowledgeAllowed(did: string, workspace: string, selection: KnowledgeSelection): Promise<boolean> {
    const record = await this.options.store.get(did);
    const knowledge = record?.settings.knowledge;
    return Boolean(record?.settings.workspaceId === workspace && knowledge?.workspaceId === workspace
      && knowledge.enabled && knowledge.sources.some((item) => canonicalJson(item) === canonicalJson(selection)));
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
      const previous = record.settings.repository;
      const resolved = this.repository.resolve ? await this.repository.resolve(input) : { url: parsePublicHttps(input.url).href };
      const url = resolved.url;
      if (!this.repository.resolve && new URL(url).search) throw new AccountError(400, "Repository URLs cannot contain query parameters.");
      const sameRepository = previous?.url === url;
      const token =
        input.token ??
        (!input.clearToken && sameRepository && record.repoToken
          ? await this.options.box.open<string>(record.repoToken)
          : undefined);
      const username = input.username || (sameRepository ? previous?.username : undefined);
      const credentialHost = input.credentialHost || (sameRepository ? previous?.credentialHost : undefined);
      if (input.discoverDefaultBranch && !this.repository.discover)
        throw new AccountError(422, "Default branch discovery is unavailable. Enter the branch name.");
      const branch = input.discoverDefaultBranch
        ? await this.repository.discover!({ url, username, token, credentialHost } as ForgeRepositoryInput)
        : input.branch.replace(/^refs\/heads\//, "");
      const id = workspaceId(did, url, branch);
      const verified = await this.repository.prepare(
        { url, branch, ...(username ? { username } : {}), ...(token ? { token } : {}), ...(credentialHost ? { credentialHost } : {}) } as ForgeRepositoryInput,
        this.directory(id),
      );
      record.settings.workspaceId = id;
      if (record.settings.knowledge && record.settings.knowledge.workspaceId !== id) {
        // The initial onboarding choice follows the first repository. A different repository needs a new opt-in.
        if (!previous) record.settings.knowledge.workspaceId = id;
        else delete record.settings.knowledge;
      }
      for (const kind of ["telemetry", "people"] as const) {
        if (record.settings[kind] && record.settings[kind]!.workspaceId !== id) {
          if (!previous) record.settings[kind]!.workspaceId = id;
          else {
            delete record.settings[kind];
            if (kind === "telemetry") delete record.telemetryKey;
            else delete record.peopleToken;
          }
        }
      }
      record.settings.repository = {
        ...verified,
        ...("forge" in resolved ? { forge: resolved.forge } : {}),
        credentialConfigured: Boolean(token),
        ...(username ? { username } : {}),
        ...(credentialHost ? { credentialHost } : {}),
      };
      if (token) record.repoToken = await this.options.box.seal(token);
      else delete record.repoToken;
      return record;
    });
  }
  async saveMirror(did: string, input: MirrorUpdate, key: string) {
    return this.change(did, key, "mirror", input, async (record) => {
      const mirrors = record.settings.mirrors ?? [];
      if (mirrors.length >= 5) throw new AccountError(422, "A workspace can keep at most five mirrors.");
      let address: ReturnType<typeof parseRepositoryAddress>;
      try { address = parseRepositoryAddress(input.url); } catch { throw new AccountError(400, "Enter an HTTPS repository address."); }
      if (address.kind === "radicle")
        throw new AccountError(422, "Ephyra cannot move your Radicle branches: only your key can. Your own git push keeps Radicle in step.");
      if (address.kind === "tangled")
        throw new AccountError(422, "Tangled accepts pushes only over SSH, which Ephyra does not hold. Your own git push keeps Tangled in step.");
      const url = parsePublicHttps(address.cloneUrl).href;
      const host = new URL(url).hostname.toLowerCase();
      if (host === "codeberg.org" || host.endsWith(".codeberg.org"))
        throw new AccountError(422, "Codeberg's terms forbid AI-generated contributions, so Ephyra does not push there.");
      const own = record.settings.repository;
      if (own && [own.url, own.forge?.cloneUrl].includes(url)) throw new AccountError(409, "That is the workspace's own repository.");
      if (mirrors.some((m) => m.url === url)) throw new AccountError(409, "That mirror is already listed.");
      const id = `m_${createHash("sha256").update(`${record.settings.workspaceId}\0${url}`).digest("hex").slice(0, 12)}`;
      record.settings.mirrors = [...mirrors, { id, url, host, kind: address.kind, credentialConfigured: Boolean(input.token), last: null }];
      if (input.token) record.mirrorTokens = { ...record.mirrorTokens, [id]: await this.options.box.seal(input.token) };
      return record;
    });
  }
  async removeMirror(did: string, input: MirrorRemove, key: string) {
    return this.change(did, key, "mirror-remove", input, async (record) => {
      if (!record.settings.mirrors?.some((m) => m.id === input.id)) throw new AccountError(409, "That mirror is not listed.");
      record.settings.mirrors = record.settings.mirrors.filter((m) => m.id !== input.id);
      if (record.mirrorTokens) delete record.mirrorTokens[input.id];
      return record;
    });
  }
  /**
   * After a landing moved the base branch, bring each mirror to the same commit. A mirror moves only when it is behind
   * (its tip is an ancestor of the new commit); a diverged mirror is reported, never overwritten. A failure never
   * fails the landing. The result is recorded on the mirror, with its host only.
   */
  async pushMirrors(did: string, workspace: string, receipt: Pick<LandingReceipt, "newOid">): Promise<void> {
    const record = await this.record(did);
    const repository = record.settings.repository;
    const mirrors = record.settings.mirrors ?? [];
    if (record.settings.workspaceId !== workspace || !repository || !mirrors.length || !this.repository.command) return;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.newOid)) return;
    const branch = `refs/heads/${repository.branch.replace(/^refs\/heads\//, "")}`;
    const results = new Map<string, NonNullable<(typeof mirrors)[number]["last"]>>();
    for (const mirror of mirrors) {
      const at = new Date().toISOString();
      try {
        const token = record.mirrorTokens?.[mirror.id] ? await this.options.box.open<string>(record.mirrorTokens[mirror.id]!) : undefined;
        const input = { url: mirror.url, branch: repository.branch.replace(/^refs\/heads\//, ""), ...(token ? { token } : {}) };
        const read = await this.repository.command(input, this.directory(workspace),
          ["git", "ls-remote", "--refs", "--exit-code", "--", mirror.url, branch]);
        const tip = read.code === 0 ? read.stdout.trim().split(/\s+/)[0] ?? "" : read.code === 2 ? "" : null;
        if (tip === null) throw new Error("The mirror could not be read. Check its address and token.");
        if (tip === receipt.newOid) { results.set(mirror.id, { status: "ok", at, commit: tip, detail: "Already up to date." }); continue; }
        if (tip && !await this.isAncestor(workspace, tip, receipt.newOid))
          throw new Error("The mirror has commits the workspace does not. It was left as it is.");
        const pushed = await this.repository.command(input, this.directory(workspace), ["git", "push", "--porcelain", "--no-verify",
          `--force-with-lease=${branch}:${tip}`, "--", mirror.url, `${receipt.newOid}:${branch}`]);
        if (pushed.code !== 0) throw new Error("The mirror refused the push. Check its token can write to that branch.");
        results.set(mirror.id, { status: "ok", at, commit: receipt.newOid, detail: "Pushed." });
      } catch (error) {
        const detail = error instanceof Error && !(error instanceof AccountError) ? error.message : "The mirror push failed.";
        results.set(mirror.id, { status: "failed", at, commit: receipt.newOid, detail: redactModelText(detail).slice(0, 500) });
        console.log(JSON.stringify({ msg: "mirror push failed", workspace, host: mirror.host }));
      }
    }
    await this.change(did, `mirror-result:${receipt.newOid.slice(0, 40)}:${record.settings.version}`, "mirror-result",
      { expectedVersion: record.settings.version, newOid: receipt.newOid } as { expectedVersion: number }, async (next) => {
        next.settings.mirrors = next.settings.mirrors?.map((m) => results.has(m.id) ? { ...m, last: results.get(m.id)! } : m);
        return next;
      }).catch(() => { /* a newer settings change wins; the next landing records again */ });
  }
  private async isAncestor(workspace: string, ancestor: string, descendant: string): Promise<boolean> {
    if (![ancestor, descendant].every((o) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(o))) return false;
    const child = Bun.spawn(["git", "--git-dir", join(this.directory(workspace), "workspace.git"), "merge-base", "--is-ancestor",
      ancestor, descendant], { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    return await child.exited === 0;
  }
  async saveModel(did: string, input: ModelUpdate, key: string) {
    return this.saveModelSlot(did, input, key, "code");
  }
  /** A model for a role other than coding. `provider: "none"` removes it, so the coding model does that job again. */
  async saveRoleModel(did: string, input: RoleModelUpdate, key: string) {
    const { role, ...update } = input;
    return this.saveModelSlot(did, update, key, role);
  }
  private async saveModelSlot(did: string, input: ModelUpdate, key: string, role: AgentRole) {
    const current = (record: AccountRecord) => role === "code" ? record.settings.model : record.settings.roleModels?.[role];
    const sealedKey = (record: AccountRecord) => role === "code" ? record.modelKey : record.roleModelKeys?.[role];
    return this.change(did, key, role === "code" ? "model" : `model:${role}`, input, async (record) => {
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
      const previous = current(record);
      const sameDestination = previous?.provider === input.provider && previous?.baseUrl === baseUrl;
      const saved = sealedKey(record);
      const apiKey = byok
        ? (input.apiKey ?? (!input.clearKey && sameDestination && saved ? await this.options.box.open<string>(saved) : undefined))
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
      if (role === "code") {
        record.settings.model = model;
        if (apiKey) record.modelKey = await this.options.box.seal(apiKey);
        else delete record.modelKey;
        return record;
      }
      const roles = { ...record.settings.roleModels };
      const keys = { ...record.roleModelKeys };
      if (input.provider === "none") { delete roles[role]; delete keys[role]; }
      else {
        roles[role] = model;
        if (apiKey) keys[role] = await this.options.box.seal(apiKey);
        else delete keys[role];
      }
      if (Object.keys(roles).length) record.settings.roleModels = roles; else delete record.settings.roleModels;
      if (Object.keys(keys).length) record.roleModelKeys = keys; else delete record.roleModelKeys;
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
  async modelFor(did: string, workspace: string, role: AgentRole = "code"): Promise<DraftModel | null> {
    const record = await this.record(did);
    if (record.settings.workspaceId !== workspace)
      throw new Unverified("This workspace is no longer selected. Open the current workspace.");
    // A role without its own model falls back to the coding model; the usage receipt names whichever model ran.
    const own = role === "code" ? undefined : record.settings.roleModels?.[role];
    const model = own ?? record.settings.model;
    const modelKey = own ? record.roleModelKeys?.[role] : record.modelKey;
    if (model.provider === "none") return null;
    if (model.provider === "notorganic") {
      if (!(await this.options.signIn.hasScope(did, `infer:${model.model}`)))
        throw new Unverified("Allow the selected hosted model in Settings by signing in again.");
      return new NotOrganicDraftModel(this.options.signIn, did, model.model);
    }
    if (!modelKey || !model.baseUrl) return null;
    const apiKey = await this.options.box.open<string>(modelKey);
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
            text: redactModelText(result.text, [apiKey], 150_000),
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
