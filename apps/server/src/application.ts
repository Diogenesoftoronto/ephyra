import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { RepositoryUpdate, ModelUpdate, OnboardingUpdate, TeamInviteInput, TeamRevokeInput, TeamAcceptInput,
  KnowledgeUpdate, TelemetryUpdate, PeopleUpdate, InvestigationAnswer, Unverified } from "@ephyra/core";
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
import { accountBootstrapCoverage } from "./setup/account-bootstrap.ts";
import { createAgentAccess } from "./auth/agent-service.ts";
import { ConvexAgentStore, MemoryAgentStore, type AgentStore } from "./auth/agent-store.ts";
import { agentAuthRoutes } from "./auth/agent-routes.ts";
import { agentSetupRoutes } from "./http/agent-setup.ts";
import { agentManagementRoutes } from "./auth/agent-management.ts";

export type ApplicationOptions = ComposeOverrides & {
  accountStore?: AccountStore;
  agentStore?: AgentStore;
  repository?: AccountOptions["repository"];
  providerFetch?: AccountOptions["fetcher"];
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
  accounts = new Accounts({
    store,
    box,
    operationSecret: config.EPHYRA_SESSION_KEY,
    dataDir: config.EPHYRA_DATA_DIR,
    signIn,
    repository: connector,
    fetcher: opts.providerFetch,
    automation: (did) => opts.workspaceAutomation ? { provider: "custom", configured: true, detail: "A workspace hosting integration is configured." }
      : hostingStatus(config, did),
    onWorkspaceChange: (before) => {
      void runtimes.get(before)?.then((runtime) => runtime.close(), () => undefined);
      runtimes.delete(before);
    },
  });
  const account = accounts;
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
          : await hostedAutomation(config, { did, workspaceId, directory }, () => account.modelFor(did, workspaceId));
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
          resolveApprover: (principal) => teams.canApprove(did, workspaceId, principal),
          resolveTelemetry: () => account.telemetryFor(did, workspaceId),
          assessBootstrap: (run) => accountBootstrapCoverage(account, did, workspaceId, run),
          landing: automation?.landing ?? personalLanding({ accounts: account, did, workspace: workspaceId }),
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
    close: async () => {
      await legacy.close();
      await Promise.allSettled([...runtimes.values()].map(async (p) => (await p).close()));
    },
  };
}
