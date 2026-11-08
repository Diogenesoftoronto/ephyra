import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { RepositoryUpdate, ModelUpdate, OnboardingUpdate, TeamInviteInput, TeamRevokeInput, TeamAcceptInput } from "@ephyra/core";
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
import { RepositoryConnector } from "./setup/repository.ts";
import { Teams } from "./setup/team.ts";
import { forwardSharedRequest } from "./setup/team-stream.ts";

export type ApplicationOptions = ComposeOverrides & {
  accountStore?: AccountStore;
  repository?: AccountOptions["repository"];
  providerFetch?: AccountOptions["fetcher"];
  /** The host provisions these for this account/workspace. Deployment CLI credentials are never inherited. */
  workspaceAutomation?: (scope: { did: string; workspaceId: string; directory: string }) => Promise<
    Pick<ComposeOverrides, "agent" | "runner" | "decide" | "evidenceSources" | "automationReadiness">
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
  const connector = opts.repository ?? new RepositoryConnector();
  accounts = new Accounts({
    store,
    box,
    operationSecret: config.EPHYRA_SESSION_KEY,
    dataDir: config.EPHYRA_DATA_DIR,
    signIn,
    repository: connector,
    fetcher: opts.providerFetch,
    onWorkspaceChange: (before) => {
      void runtimes.get(before)?.then((runtime) => runtime.jobs.stop());
    },
  });
  const account = accounts;
  const teams = new Teams(store, config.EPHYRA_SESSION_KEY);

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
            { url: repository.url, branch: repository.branch, username: repository.username, token },
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
        });
        const automation = await opts.workspaceAutomation?.({ did, workspaceId, directory });
        if (automation?.agent && !automation.runner)
          throw new AccountError(503, "The workspace coding agent needs its own isolated runner.");
        return compose(personal, {
          ...automation,
          startJobs: opts.startJobs,
          workspace: workspaceId,
          signIn,
          workspacePrepared: true,
          resolveDraftModel: () => account.modelFor(did, workspaceId),
          resolveApprover: (principal) => teams.canApprove(did, workspaceId, principal),
        });
      })().catch((error) => {
        runtimes.delete(workspaceId);
        throw error;
      });
      runtimes.set(workspaceId, pending);
    }
    const composed = await pending;
    if (opts.startJobs !== false) composed.jobs.start();
    return composed;
  }

  const app = new Hono<AuthEnv>();
  app.onError((error, c) => {
    if (error instanceof AccountError) return c.json({ error: error.message }, error.status);
    // Connection/provider/DB bodies can contain credentials. Never reflect or log them here.
    return c.json({ error: "The request could not be completed. Refresh to check the saved state." }, 503);
  });
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
  app.put("/v1/account/repository", async (c) => {
    const value = RepositoryUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the repository URL, branch and credentials." }, 400);
    return c.json(await account.saveRepository(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.put("/v1/account/model", async (c) => {
    const value = ModelUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Check the model, provider URL and key." }, 400);
    return c.json(await account.saveModel(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
  });
  app.put("/v1/account/onboarding", async (c) => {
    const value = OnboardingUpdate.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "Invalid setup action." }, 400);
    return c.json(await account.onboarding(c.get("principal"), value.data, c.req.header("Idempotency-Key") ?? ""));
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
