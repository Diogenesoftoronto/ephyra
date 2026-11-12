import type { Context } from "hono";
import { browserSessionToken } from "./auth/browser-session.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { RepositoryUpdate, ModelUpdate, OnboardingUpdate, TeamInviteInput, TeamRevokeInput, TeamAcceptInput,
  KnowledgeUpdate, TelemetryUpdate, PeopleUpdate, InvestigationAnswer, Unverified, MirrorRemove, MirrorUpdate, RoleModelUpdate } from "@ephyra/core";
import { compose, type Composed, type ComposeOverrides } from "./compose.ts";
import { readConfig, type Config } from "./config.ts";
import { auth, type AuthEnv } from "./http/auth.ts";
import { SecretBox } from "./auth/crypto.ts";
import { convexClient } from "./convex/stores.ts";
import { Accounts, AccountError, type AccountOptions } from "./setup/accounts.ts";
import {
  ConvexAccountStore,
  MemoryAccountStore,
  type AccountRecord,
  type AccountStore,
} from "./setup/account-store.ts";
import { Teams } from "./setup/team.ts";
import { ProfileDirectory, portalProfileUrl } from "./auth/profiles.ts";
import { OwnProfile, TeamPeople } from "@ephyra/core";
import { forwardSharedRequest } from "./setup/team-stream.ts";
import { ForgeRepositoryConnector } from "./setup/forge-repository.ts";
import { NotOrganicEvidence } from "./setup/knowledge-evidence.ts";
import { KnowledgeOperationLedger } from "./setup/knowledge-ledger.ts";
import { openAnswerTicket } from "./setup/questions.ts";
import { answerPage } from "./setup/answer-page.ts";
import { hostedAutomation, hostingStatus } from "./setup/hosting.ts";
import { provisionSetup } from "./setup/provisioning.ts";
import { canonicalJson } from "./audit.ts";
import { proofToolchain } from "./setup/proof-toolchain.ts";
import { personalLanding } from "./setup/personal-landing.ts";
import { radicleWriterConfig } from "./setup/radicle-writer.ts";
import { appManifest, convertManifest, githubAppConfig } from "./setup/github-app.ts";
import { accountBootstrapCoverage } from "./setup/account-bootstrap.ts";
import { createAgentAccess } from "./auth/agent-service.ts";
import { ConvexAgentStore, MemoryAgentStore, type AgentStore } from "./auth/agent-store.ts";
import { agentAuthRoutes } from "./auth/agent-routes.ts";
import { agentSetupRoutes } from "./http/agent-setup.ts";
import { agentManagementRoutes } from "./auth/agent-management.ts";
import { intakeFresh, recordIntake, reportSelfError, verifyWorkspaceIngestToken, workspaceIngestToken } from "./self-telemetry.ts";

export type ApplicationOptions = ComposeOverrides & {
  accountStore?: AccountStore;
  agentStore?: AgentStore;
  repository?: AccountOptions["repository"];
  providerFetch?: AccountOptions["fetcher"];
  /** Test seam for the Not Organic profile reader. */
  profiles?: ProfileDirectory;
  /** The host provisions these for this account/workspace. Deployment CLI credentials are never inherited. */
  workspaceAutomation?: (scope: { did: string; workspaceId: string; directory: string }) => Promise<
    Pick<ComposeOverrides, "agent" | "runner" | "decide" | "evidenceSources" | "automationReadiness" | "profile"
      | "landing" | "verification" | "respondents" | "ampReports">
  >;
};

/** Personal workspaces share the account authority but never project stores, repo paths, provider keys or policy files. */
export async function composeApplication(config: Config, opts: ApplicationOptions = {}) {
  let accounts: Accounts | null = null;
  const legacy = await compose(config, { ...opts, setupScopes: (did) => accounts?.scopes(did) ?? Promise.resolve([]) });
  if (!legacy.signIn || !config.EPHYRA_SESSION_KEY) return { ...legacy, accounts };
  const signIn = legacy.signIn;
  const client = config.CONVEX_URL
    ? convexClient({ url: config.CONVEX_URL, secret: config.EPHYRA_CONVEX_SECRET! })
    : null;
  const store =
    opts.accountStore ??
    (client ? new ConvexAccountStore(client, config.EPHYRA_CONVEX_SECRET!) : new MemoryAccountStore());
  const box = await SecretBox.fromBase64(config.EPHYRA_SESSION_KEY);
  const runtimes = new Map<string, Promise<Composed>>();
  const connector = opts.repository ?? new ForgeRepositoryConnector();
  const githubApp = githubAppConfig(config);
  accounts = new Accounts({
    store,
    box,
    operationSecret: config.EPHYRA_SESSION_KEY,
    dataDir: config.EPHYRA_DATA_DIR,
    signIn,
    repository: connector,
    fetcher: opts.providerFetch,
    githubApp: githubApp,
    automation: (did) => opts.workspaceAutomation ? { provider: "custom", configured: true, detail: "A workspace hosting integration is configured." }
      : hostingStatus(config, did),
    onWorkspaceChange: (before) => {
      void runtimes.get(before)?.then((runtime) => runtime.close(), () => undefined);
      runtimes.delete(before);
    },
  });
  const account = accounts;
  const radicleWriter = radicleWriterConfig(config).config;
  const teams = new Teams(store, config.EPHYRA_SESSION_KEY);
  const agents = createAgentAccess({
    store: opts.agentStore ?? (client ? new ConvexAgentStore(client, config.EPHYRA_CONVEX_SECRET!) : new MemoryAgentStore()),
    origin: config.EPHYRA_PUBLIC_ORIGIN!, signingSecret: config.EPHYRA_SESSION_KEY, signIn,
    resolveBinding: async (did, proposal, registrationId) => {
      let record = await account.record(did);
      if (record.settings.repository && (record.settings.repository.url !== proposal.url
        || record.settings.repository.branch !== proposal.branch))
        throw new AccountError(409, "The proposed repository differs from your current workspace. Select it in settings and start a new claim.");
      if (!record.settings.repository) {
        await account.saveRepository(did, { expectedVersion: record.settings.version, ...proposal }, `agent-claim:${registrationId}`);
        record = await account.record(did);
      }
      const repository = record.settings.repository;
      if (!repository || repository.url !== proposal.url || repository.branch !== proposal.branch)
        throw new AccountError(409, "The repository changed during agent approval. Start a new claim.");
      return { ownerDid: did, workspaceId: record.settings.workspaceId, repositoryRevision: repository.verifiedAt,
        repository: { url: repository.url, branch: repository.branch } };
    },
    currentBinding: async (did) => {
      const record = await store.get(did);
      const repository = record?.settings.repository;
      return record && repository ? { ownerDid: did, workspaceId: record.settings.workspaceId, repositoryRevision: repository.verifiedAt,
        repository: { url: repository.url, branch: repository.branch } } : null;
    },
  });

  async function runtime(record: AccountRecord): Promise<Composed> {
    const { workspaceId, did, repository } = record.settings;
    let pending = runtimes.get(workspaceId);
    if (!pending) {
      pending = (async () => {
        const directory = account.directory(workspaceId);
        const mirror = join(directory, "workspace.git");
        const exists = await access(join(mirror, "HEAD")).then(
          () => true,
          () => false,
        );
        if (!exists && repository) {
          const token = record.repoToken ? await box.open<string>(record.repoToken) : undefined;
          await connector.prepare(
            { url: repository.url, branch: repository.branch, username: repository.username, token, credentialHost: repository.credentialHost },
            directory,
          );
        } else if (!exists) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const proc = Bun.spawn(["git", "init", "--bare", "-q", mirror], {
            stdout: "ignore",
            stderr: "ignore",
            env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          });
          if ((await proc.exited) !== 0) throw new Error("Workspace could not be initialized.");
        }
        // Build from an allowlist: deployment keys, trusted local runners and policy overrides cannot leak into a personal workspace.
        const personal = readConfig({
          EPHYRA_API_TOKEN: config.EPHYRA_API_TOKEN,
          CONVEX_URL: config.CONVEX_URL,
          EPHYRA_CONVEX_SECRET: config.EPHYRA_CONVEX_SECRET,
          EPHYRA_DATA_DIR: directory,
          EPHYRA_REPO_ID: workspaceId,
          EPHYRA_REPO_URL: repository?.url,
          EPHYRA_FORGE: repository?.forge?.kind === "radicle" ? "radicle" : repository?.forge?.kind === "tangled" ? "tangled" : "plain",
          EPHYRA_DECIDE: "notorganic",
          EPHYRA_BASE_REF: repository
            ? `refs/heads/${repository.branch.replace(/^refs\/heads\//, "")}`
            : "refs/heads/main",
          EPHYRA_PUBLIC_ORIGIN: config.EPHYRA_PUBLIC_ORIGIN,
          EPHYRA_SESSION_KEY: config.EPHYRA_SESSION_KEY,
          EPHYRA_APPROVER_DIDS: did,
          EPHYRA_BILLING_DID: did,
          NOTORGANIC_ISSUER: config.NOTORGANIC_ISSUER,
          NOTORGANIC_AUTHORIZATION_URL: config.NOTORGANIC_AUTHORIZATION_URL,
          NOTORGANIC_PRODUCT: config.NOTORGANIC_PRODUCT,
          EPHYRA_CONSOLE_DIR: config.EPHYRA_CONSOLE_DIR,
          EPHYRA_TRAIL_TOKENS: String(config.EPHYRA_TRAIL_TOKENS),
          EPHYRA_TRAIL_WALLCLOCK_S: String(config.EPHYRA_TRAIL_WALLCLOCK_S),
          EPHYRA_TRAIL_SPEND_MICROUSD: String(config.EPHYRA_TRAIL_SPEND_MICROUSD),
          EPHYRA_REQUIRE_KNOWN_COST: "true",
          // Host grants explicitly name workspace IDs; account settings cannot choose a trust file or source.
          EPHYRA_PROOF_RECEIPTS_DIR: config.EPHYRA_PROOF_RECEIPTS_DIR,
          EPHYRA_PROOF_TRUST_FILE: config.EPHYRA_PROOF_TRUST_FILE,
        });
        const hosted = opts.workspaceAutomation ? null
          : await hostedAutomation(config, { did, workspaceId, directory }, (role) => account.modelFor(did, workspaceId, role));
        const automation: ComposeOverrides | undefined = await opts.workspaceAutomation?.({ did, workspaceId, directory }) ?? hosted ?? undefined;
        const knowledgeLedger = config.CONVEX_URL ? undefined : new KnowledgeOperationLedger(join(directory, "knowledge-operations"));
        if (automation?.agent && !automation.runner)
          throw new AccountError(503, "The workspace coding agent needs its own isolated runner.");
        const composed: Composed = await compose(personal, {
          ...automation,
          startJobs: false,
          workspace: workspaceId,
          signIn,
          workspacePrepared: true,
          operationLedger: knowledgeLedger,
          ...(hosted ? { setupProvision: (run) => provisionSetup({ runner: hosted.runner, profile: hosted.profile,
            ledger: hosted.ledger, repoUrl: repository?.url ?? "", scope: `${did}:${workspaceId}` }, run),
          prepareProof: async (runner, handle, trail) => {
            const setup = await composed.setup.current();
            if (!setup || !trail.head) throw new Unverified("a pinned workspace baseline is required before proof");
            return proofToolchain({ runner, handle, setup, base: trail.base.sha, head: trail.head, ledger: hosted.ledger });
          } } : {}),
          resolveDraftModel: () => account.modelFor(did, workspaceId),
          otlpFresh: () => intakeFresh(directory),
          resolveApprover: (principal) => teams.canApprove(did, workspaceId, principal),
          resolveTelemetry: () => account.telemetryFor(did, workspaceId),
          assessBootstrap: (run) => accountBootstrapCoverage(account, did, workspaceId, run),
          landing: automation?.landing ?? personalLanding({ accounts: account, did, workspace: workspaceId, radicle: radicleWriter }),
          questions: { did, workspaceId, model: () => account.modelFor(did, workspaceId),
            connection: () => account.peopleFor(did, workspaceId), box, publicOrigin: config.EPHYRA_PUBLIC_ORIGIN!,
            fetcher: opts.providerFetch },
          bootstrapContact: { did, workspaceId, connection: () => account.peopleFor(did, workspaceId),
            publicOrigin: config.EPHYRA_PUBLIC_ORIGIN!, fetcher: opts.providerFetch },
          resolveEvidenceSources: async (ledger) => {
            const current = await account.record(did);
            const knowledge = current.settings.knowledge;
            if (current.settings.workspaceId !== workspaceId) return [];
            const telemetry = await account.telemetryFor(did, workspaceId);
            const sources = knowledge?.enabled && knowledge.workspaceId === workspaceId ? knowledge.sources : [];
            return [...sources.map((selection) => new NotOrganicEvidence({
              gateway: account.knowledgeGateway, scope: { did, workspaceId }, selection, ledger: knowledgeLedger ?? ledger,
              authorize: () => account.knowledgeAllowed(did, workspaceId, selection),
            })), ...(telemetry ? [telemetry] : [])];
          },
        });
        await hosted?.attach(composed.ctx);
        return composed;
      })().catch((error) => {
        runtimes.delete(workspaceId);
        throw error;
      });
      runtimes.set(workspaceId, pending);
    }
    const composed = await pending;
    if (opts.startJobs !== false) await composed.start();
    return composed;
  }

  const app = new Hono<AuthEnv>();
  app.onError((error, c) => {
    if (error instanceof AccountError) return c.json({ error: error.message }, error.status);
    reportSelfError(error, "http", c.req.routePath);
    // Connection/provider/DB bodies can contain credentials. Never reflect or log them here.
    return c.json({ error: "The request could not be completed. Refresh to check the saved state." }, 503);
  });
  app.route("/", agentAuthRoutes(agents));
  app.route("/", agentManagementRoutes(agents, box));
  app.route("/", agentSetupRoutes({ access: agents, runtime: async (principal) => {
    const record = await account.record(principal.ownerDid);
    if (record.settings.workspaceId !== principal.workspaceId) throw new AccountError(409, "The agent workspace changed.");
    return runtime(record);
  } }));
  app.use(
    "/v1/*",
    auth(config.EPHYRA_API_TOKEN, (token) => signIn.authenticate(token), config.EPHYRA_PUBLIC_ORIGIN),
  );
  // Personal profile: available in every workspace, including shared viewer workspaces. Read-only; Not Organic owns edits.
  const profiles = opts.profiles ?? new ProfileDirectory(signIn, { portalUrl: portalProfileUrl(config.NOTORGANIC_AUTHORIZATION_URL) });
  /** People this principal may see: themself, owners of workspaces shared with them, and members of their own team. */
  async function visiblePeople(did: string): Promise<string[]> {
    const own = await teams.team(did);
    const shared = (await teams.workspaces(did)).filter((w) => w.role !== "owner").map((w) => w.ownerDid);
    return [did, ...shared, ...own.invitations.filter((i) => i.acceptedBy && !i.revokedAt).map((i) => i.acceptedBy!)];
  }
  app.get("/v1/profile", async (c) => {
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in with Not Organic to see your profile." }, 403);
    c.header("Cache-Control", "no-store");
    return c.json(OwnProfile.parse(await profiles.own(c.get("principal"), c.req.query("fresh") === "1")));
  });
  app.get("/v1/profiles", async (c) => {
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in with Not Organic to see team members." }, 403);
    const did = c.get("principal");
    const workspace = c.req.header("X-Ephyra-Workspace") ?? (await account.record(did)).settings.workspaceId;
    const owned = (await account.record(did)).settings.workspaceId === workspace;
    const shared = owned ? null : await teams.shared(did, workspace);
    if (!owned && !shared) return c.json({ error: "Your workspace changed or access is unavailable. Reload before continuing." }, 409);
    // In a shared workspace the person sees themself and the owner only; the owner's team list stays with the owner.
    const people = owned ? await visiblePeople(did) : [did, shared!.record.settings.did];
    c.header("Cache-Control", "no-store");
    return c.json(TeamPeople.parse({ workspaceId: workspace, people: await profiles.many(people) }));
  });
  app.get("/v1/profiles/:did/avatar", async (c) => {
    if (c.get("principalKind") !== "human") return c.body(null, 403);
    const target = c.req.param("did");
    const allowed = new Set(await visiblePeople(c.get("principal")));
    if (!allowed.has(target)) return c.body(null, 404);
    const image = await profiles.avatar(target);
    if (!image) return c.body(null, 404);
    return c.body(image.bytes.slice().buffer, 200, { "Content-Type": image.type, "Cache-Control": "private, max-age=600",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  });
  // A workspace's own OTLP intake. The token is derived per workspace and shown only to its owner; signals land in
  // that workspace, where its policy and approvers apply. The deployment intake at /otlp/v1/* is unchanged.
  let owners = { at: 0, byWorkspace: new Map<string, AccountRecord>() };
  app.post("/otlp/workspaces/:workspace/v1/:kind{logs|traces}", async (c) => {
    const workspace = c.req.param("workspace");
    if (!/^ws_[a-f0-9]{40}$/.test(workspace)
      || !verifyWorkspaceIngestToken(config.EPHYRA_SESSION_KEY!, workspace, c.req.header("Authorization")))
      return c.json({ error: "unauthorized" }, 401);
    if (Date.now() - owners.at > 30_000 || !owners.byWorkspace.has(workspace))
      owners = { at: Date.now(), byWorkspace: new Map((await store.list()).map((r) => [r.settings.workspaceId, r])) };
    const record = owners.byWorkspace.get(workspace);
    if (!record) return c.json({ error: "unauthorized" }, 401);
    const target = await runtime(record);
    const headers = new Headers({ Authorization: `Bearer ${config.EPHYRA_API_TOKEN}` });
    for (const name of ["content-type", "content-length"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const url = new URL(c.req.url);
    url.pathname = `/otlp/v1/${c.req.param("kind")}`;
    const response = await target.app.fetch(new Request(url, { method: "POST", headers, body: c.req.raw.body, duplex: "half" } as RequestInit));
    if (response.ok) await recordIntake(account.directory(workspace)).catch(() => undefined);
    return response;
  });
  // GitHub App creation (operator) and installation (owner). Both are browser pages, signed in with Not Organic.
  const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>body{font:16px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px}code,pre{background:#f3f0e8;padding:2px 4px;border-radius:4px;white-space:pre-wrap;word-break:break-all}</style>
<h1>${title}</h1>${body}`;
  const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const sessionDid = async (c: Context) =>
    (await signIn.authenticate(browserSessionToken(c, config.EPHYRA_PUBLIC_ORIGIN!) ?? "").catch(() => null))?.did ?? null;
  const operator = async (c: Context) => {
    const did = await sessionDid(c);
    return did && config.EPHYRA_APPROVER_DIDS.split(",").map((s) => s.trim()).includes(did) ? did : null;
  };
  app.get("/github/app/new", async (c) => {
    if (!await operator(c)) return c.html(page("Sign in first", `<p><a href="/auth/login">Sign in</a> as an operator, then open this page again.</p>`), 403);
    if (githubApp) return c.html(page("GitHub App is set up", `<p>This server already has a GitHub App (<code>${escape(githubApp.slug)}</code>).</p>`));
    const manifest = escape(JSON.stringify(appManifest(config.EPHYRA_PUBLIC_ORIGIN!)));
    return c.html(page("Create the Ephyra GitHub App", `<p>GitHub will ask you to name the app and confirm. It asks only for
contents and pull requests (write) plus checks and statuses (read), and no webhook.</p>
<form action="https://github.com/settings/apps/new" method="post"><input type="hidden" name="manifest" value="${manifest}">
<button type="submit">Create the app on GitHub</button></form>`));
  });
  app.get("/github/app/created", async (c) => {
    if (!await operator(c)) return c.html(page("Sign in first", `<p>Sign in as an operator and create the app again.</p>`), 403);
    try {
      const created = await convertManifest(c.req.query("code") ?? "", (url, init) => fetch(url, init));
      c.header("Cache-Control", "no-store");
      return c.html(page("GitHub App created", `<p>Set these on the server, then redeploy. The key is shown once and is not stored here.</p>
<pre>EPHYRA_GITHUB_APP_ID=${escape(created.appId)}
EPHYRA_GITHUB_APP_SLUG=${escape(created.slug)}
EPHYRA_GITHUB_APP_PRIVATE_KEY=${escape(created.privateKey.replace(/\n/g, "\\n"))}</pre>`));
    } catch (error) {
      return c.html(page("GitHub App not created", `<p>${escape(error instanceof Error ? error.message : "GitHub did not confirm.")}</p>`), 422);
    }
  });
  app.get("/github/install/callback", async (c) => {
    const did = await sessionDid(c);
    if (!did) return c.redirect(`/auth/login?returnTo=${encodeURIComponent(c.req.url.replace(/^https?:\/\/[^/]+/, ""))}`);
    const installationId = c.req.query("installation_id") ?? "";
    try {
      await account.connectGitHubApp(did, installationId, `github-app:${installationId}:${Date.now()}`);
      return c.redirect("/app/#/settings");
    } catch (error) {
      return c.html(page("GitHub not connected", `<p>${escape(error instanceof Error ? error.message : "GitHub did not confirm.")}</p>
<p><a href="/app/#/settings">Back to settings</a></p>`), 422);
    }
  });
  app.use(
    "/v1/account/*",
    bodyLimit({ maxSize: 24_000, onError: (c) => c.json({ error: "The settings request is too large." }, 413) }),
  );
  app.use("/v1/account*", async (c, next) => {
    if (c.get("principalKind") !== "human")
      return c.json({ error: "Sign in with Not Organic to configure your personal workspace." }, 403);
    const bound = c.req.header("X-Ephyra-Account");
    if ((bound && bound !== c.get("principal")) || (!bound && !["GET", "HEAD"].includes(c.req.method))) {
      return c.json({ error: "Your account changed. Reload before changing settings." }, 409);
    }
    const workspace = c.req.header("X-Ephyra-Workspace");
    if (workspace && workspace !== (await account.record(c.get("principal"))).settings.workspaceId)
      return c.json({ error: "Your workspace changed. Reload before changing settings." }, 409);
    await next();
  });
  app.get("/v1/account", async (c) => c.json(await account.settings(c.get("principal"))));
  /** Whether "Connect with GitHub" is available, and where it goes. Never exposes the app key. */
  app.get("/v1/account/github-app", (c) => c.json(githubApp
    ? { available: true, installUrl: `https://github.com/apps/${githubApp.slug}/installations/new` }
    : { available: false, installUrl: null }));
  /** The owner's OTLP intake for their current workspace. Any service that speaks OTLP/HTTP JSON can report here. */
  app.get("/v1/account/telemetry/otlp", async (c) => {
    const { workspaceId, repository } = (await account.record(c.get("principal"))).settings;
    c.header("Cache-Control", "no-store");
    return c.json({ workspaceId, repository: Boolean(repository),
      endpoint: `${config.EPHYRA_PUBLIC_ORIGIN}/otlp/workspaces/${workspaceId}/v1/logs`,
      token: workspaceIngestToken(config.EPHYRA_SESSION_KEY!, workspaceId) });
  });
  app.get("/v1/account/workspaces", async (c) => c.json(await teams.workspaces(c.get("principal"))));
  app.get("/v1/account/team", async (c) => c.json(await teams.team(c.get("principal"), c.req.header("X-Ephyra-Workspace"))));
  app.post("/v1/account/team/invitations", async (c) => {
    const value = TeamInviteInput.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Choose a label and a Viewer or Approver role." }, 400);
    if (c.req.header("X-Ephyra-Workspace") !== value.data.workspaceId)
      return c.json({ error: "Your workspace changed. Refresh before inviting a teammate." }, 409);
    return c.json(await teams.invite(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.post("/v1/account/team/revoke", async (c) => {
    const value = TeamRevokeInput.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Choose an invitation to revoke." }, 400);
    if (c.req.header("X-Ephyra-Workspace") !== value.data.workspaceId)
      return c.json({ error: "Your workspace changed. Refresh before revoking access." }, 409);
    return c.json(await teams.revoke(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.post("/v1/account/team/accept", async (c) => {
    const value = TeamAcceptInput.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "This invitation link is invalid." }, 400);
    return c.json(await teams.accept(c.get("principal"), value.data.token, c.req.header("Idempotency-Key") ?? ""));
  });
  app.post("/v1/account/team/preview", async (c) => {
    const value = TeamAcceptInput.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "This invitation link is invalid." }, 400);
    return c.json(await teams.preview(c.get("principal"), value.data.token));
  });
  app.get("/v1/account/agents", async (c) => c.json(await agents.list(c.get("principal"))));
  app.delete("/v1/account/agents/:id", async (c) =>
    c.json({ revoked: await agents.revokeOwned(c.get("principal"), c.req.param("id")) }));
  app.get("/v1/account/knowledge", async (c) => c.json(await account.knowledge(c.get("principal"))));
  app.put("/v1/account/telemetry", async (c) => {
    const value = TelemetryUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the PostHog project and connection." }, 400);
    const settings = await account.saveTelemetry(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? "");
    const composed = await runtime(await account.record(c.get("principal")));
    await composed.withOwner(async () => {
      await composed.telemetry?.start(String(settings.version));
      await composed.setup.reassess();
    });
    return c.json(settings);
  });
  app.put("/v1/account/people", async (c) => {
    const value = PeopleUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the contacts and delivery bridge." }, 400);
    const settings = await account.savePeople(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? "");
    const composed = await runtime(await account.record(c.get("principal")));
    await composed.withOwner(() => composed.setup.reassess());
    return c.json(settings);
  });
  app.put("/v1/account/knowledge", async (c) => {
    const value = KnowledgeUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the selected knowledge sources and tools." }, 400);
    const settings = await account.saveKnowledge(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? "");
    const composed = await runtime(await account.record(c.get("principal")));
    await composed.withOwner(() => composed.setup.reassess());
    return c.json(settings);
  });
  app.put("/v1/account/repository", async (c) => {
    const value = RepositoryUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the repository URL, branch and credentials." }, 400);
    return c.json(await account.saveRepository(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.put("/v1/account/mirrors", async (c) => {
    const value = MirrorUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Enter an HTTPS repository address and, if it needs one, a token." }, 400);
    return c.json(await account.saveMirror(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.post("/v1/account/mirrors/remove", async (c) => {
    const value = MirrorRemove.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Choose a mirror to remove." }, 400);
    return c.json(await account.removeMirror(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  /** A model for one role (today: review). `provider: "none"` removes it, so the coding model reviews again. */
  app.put("/v1/account/models/role", async (c) => {
    const value = RoleModelUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Choose a role, then check the model, provider URL and key." }, 400);
    return c.json(await account.saveRoleModel(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.put("/v1/account/model", async (c) => {
    const value = ModelUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the model, provider URL and key." }, 400);
    const settings = await account.saveModel(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? "");
    const composed = await runtime(await account.record(c.get("principal")));
    await composed.withOwner(() => composed.setup.reassess());
    return c.json(settings);
  });
  app.put("/v1/account/onboarding", async (c) => {
    const value = OnboardingUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Invalid setup action." }, 400);
    return c.json(await account.onboarding(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.use("/v1/questions*", async (c, next) => {
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in to read investigation questions." }, 403);
    const record = await account.record(c.get("principal"));
    const workspace = c.req.header("X-Ephyra-Workspace"), owner = c.req.header("X-Ephyra-Account");
    if (workspace && workspace !== record.settings.workspaceId || owner && owner !== c.get("principal"))
      return c.json({ error: "Your account or workspace changed. Reload before continuing." }, 409);
    await next();
  });
  app.get("/v1/questions", async (c) => {
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in to read investigation questions." }, 403);
    return c.json(await (await runtime(await account.record(c.get("principal")))).questions?.list() ?? []);
  });
  app.get("/v1/questions/:trail/:question", async (c) => {
    if (c.get("principalKind") !== "human") return c.json({ error: "Sign in to read this question." }, 403);
    const record = await account.record(c.get("principal"));
    if (c.req.header("X-Ephyra-Workspace") !== record.settings.workspaceId) return c.json({ error: "Workspace changed." }, 409);
    return c.json(await (await runtime(record)).questions?.get(c.req.param("trail"), c.req.param("question")) ?? null);
  });
  app.post("/v1/questions/:trail/:question/answer", bodyLimit({ maxSize: 20_000 }), async (c) => {
    const record = await account.record(c.get("principal"));
    if (c.get("principalKind") !== "human" || c.req.header("X-Ephyra-Workspace") !== record.settings.workspaceId
      || c.req.header("X-Ephyra-Account") && c.req.header("X-Ephyra-Account") !== c.get("principal"))
      return c.json({ error: "Reload the current workspace before answering." }, 409);
    const value = InvestigationAnswer.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Enter a concise factual answer." }, 400);
    const questions = (await runtime(record)).questions;
    const question = await questions?.get(c.req.param("trail"), c.req.param("question"));
    if (!question || question.recipient?.did !== c.get("principal")) return c.json({ error: "This question is for another recipient." }, 403);
    return c.json(await questions!.answer(question.trailId, question.id, question.recipient.id, value.data.text));
  });
  app.get("/answer", (c) => c.html(answerPage, 200, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }));
  app.use("/callbacks/investigation", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.on(["GET", "POST"], "/callbacks/investigation", bodyLimit({ maxSize: 20_000 }), async (c) => {
    if (c.req.header("Origin") && c.req.header("Origin") !== config.EPHYRA_PUBLIC_ORIGIN)
      return c.json({ error: "Untrusted answer origin." }, 403);
    try {
      const link = await openAnswerTicket(box, (c.req.header("Authorization") ?? "").replace(/^Bearer /, ""));
      const record = await store.get(link.did);
      if (!record || record.settings.workspaceId !== link.workspace) return c.json({ error: "This workspace changed." }, 409);
      const questions = (await runtime(record)).questions;
      const question = await questions?.get(link.trail, link.question);
      const people = await account.peopleFor(link.did, link.workspace);
      if (!question || question.recipient?.id !== link.recipient
        || !people?.settings.contacts.some((p) => canonicalJson(p) === canonicalJson(question.recipient)))
        return c.json({ error: "Question unavailable." }, 403);
      if (c.req.method === "GET") return c.json({ question: question.question, reason: question.reason, status: question.status });
      const value = InvestigationAnswer.safeParse(await c.req.json().catch(() => null));
      if (!value.success) return c.json({ error: "Enter a concise factual answer." }, 400);
      const answer = await questions!.answer(link.trail, link.question, link.recipient, value.data.text);
      return c.json({ status: answer.status });
    } catch { return c.json({ error: "The answer link or question is unavailable." }, 422); }
  });
  app.all("/v1/*", async (c) => {
    if (c.get("principalKind") === "service") return legacy.app.fetch(c.req.raw);
    const principal = c.get("principal");
    const record = await account.record(principal);
    const bound = c.req.header("X-Ephyra-Workspace");
    const reading = ["GET", "HEAD"].includes(c.req.method);
    if (!bound && !reading) {
      return c.json({ error: "Your workspace changed. Reload before continuing." }, 409);
    }
    if (bound && bound !== record.settings.workspaceId) {
      const shared = await teams.shared(principal, bound);
      if (!shared) return c.json({ error: "Your workspace changed or access is unavailable. Reload before continuing." }, 409);
      if (!reading && (shared.access.role !== "approver" || /^\/v1\/setup(?:\/|$)/.test(c.req.path)))
        return c.json({ error: shared.access.role === "viewer"
          ? "Viewer access is read-only. Ask the owner for Approver access." : "Only the workspace owner can change setup." }, 403);
      const target = await runtime(shared.record);
      return forwardSharedRequest(c.req.raw, (request) => target.app.fetch(request), () =>
        teams.stillShared(shared.record.settings.did, bound, principal, shared.invitationId));
    }
    return (await runtime(record)).app.fetch(c.req.raw);
  });
  app.all("*", (c) => legacy.app.fetch(c.req.raw));
  // Restore current queues at boot, including accounts whose browser is closed. Each namespace recovers only once.
  for (const record of await store.list()) {
    try {
      await runtime(record);
    } catch {
      console.log(JSON.stringify({ msg: "personal workspace unavailable", workspace: record.settings.workspaceId }));
    }
  }
  return {
    ...legacy,
    app,
    accounts: account,
    /** Drains one personal workspace's job queue. Tests run with startJobs: false and use this instead. */
    drainWorkspace: async (workspaceId: string) => (await runtimes.get(workspaceId))?.jobs.drain(),
    close: async () => {
      await legacy.close();
      await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close()));
    },
  };
}
