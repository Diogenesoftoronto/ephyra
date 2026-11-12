import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AccountSettings, Draft, InvestigationQuestion, PolicyDoc, SetupRun, Trail, type InvestigationContact, type UsageEntry } from "@ephyra/core";
import { GitJournal } from "@ephyra/journal";
import { SecretBox } from "./auth/crypto";
import { ownerContact, type AnswerTicket } from "./setup/questions";
import { AUTONOMY_TEMPLATE } from "@ephyra/policy";
import { composeApplication } from "./application";
import { readConfig } from "./config";
import { sessionCookieName } from "./auth/browser-session";
import { fakeNotOrganic } from "./auth/notorganic.fixture";
import { MemoryAccountStore } from "./setup/account-store";
import { RepositoryConnector, type GitExecutor } from "./setup/repository";

const ORIGIN = "https://ephyra.example";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const SERVICE = "s".repeat(32);
const KEY = "test-private-model-key-123456";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function localGit(args: string[], cwd?: string, env?: Record<string, string>) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: env ?? {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

async function fixture(withRepository = false, startJobs = false) {
  const root = await mkdtemp(join(tmpdir(), "ephyra-account-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = { approved: true, product: "ephyra", did: ALICE };
  const fake = fakeNotOrganic(identity);
  let grantedScope = "judgement:evaluate";
  const calls: { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }[] = [];
  const judgements: Record<string, unknown>[] = [];
  let respond = (url: string, body: Record<string, unknown> | null): Response => {
    if (url.endsWith("/models")) return json({ data: [{ id: "chosen-model" }] });
    const text = JSON.stringify({ text: "The selected provider answered." });
    if (url.endsWith("/messages"))
      return json({
        model: body?.model,
        content: [{ type: "text", text }],
        usage: { input_tokens: 7, output_tokens: 4 },
      });
    return json({
      model: "returned-model-identity",
      choices: [{ message: { content: text } }],
      usage: { total_tokens: 11, cost: 123 },
    });
  };
  const store = new MemoryAccountStore();
  const source = join(root, "source");
  const content = `${AUTONOMY_TEMPLATE}\n# Content from the connected repository.\n`;
  let fetches = 0;
  let repository: RepositoryConnector | undefined;
  if (withRepository) {
    await mkdir(source);
    expect(localGit(["init", "--quiet", "--initial-branch=main", "--template="], source).code).toBe(0);
    await writeFile(join(source, "autonomy.md"), content);
    expect(localGit(["add", "autonomy.md"], source).code).toBe(0);
    expect(localGit(["commit", "--quiet", "-m", "offline fixture"], source).code).toBe(0);
    const execute: GitExecutor = async (input) => {
      const args = [...input.args];
      if (args.includes("fetch") || args.includes("ls-remote")) {
        if (args.includes("fetch")) fetches++;
        args[args.indexOf("--") + 1] = pathToFileURL(source).href;
      }
      return localGit(["-c", "protocol.file.allow=always", ...args], undefined, {
        ...input.env,
        GIT_ALLOW_PROTOCOL: "file",
      });
    };
    repository = new RepositoryConnector({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], execute });
  }
  const server = await composeApplication(
    readConfig({
      EPHYRA_API_TOKEN: SERVICE,
      EPHYRA_DATA_DIR: join(root, "data"),
      EPHYRA_PUBLIC_ORIGIN: ORIGIN,
      EPHYRA_SESSION_KEY: Buffer.alloc(32, 9).toString("base64"),
      EPHYRA_APPROVER_DIDS: ALICE,
      NOTORGANIC_ISSUER: "https://api.notorganic.test",
      NOTORGANIC_AUTHORIZATION_URL: "https://id.notorganic.test/authorize",
      NOTORGANIC_PRODUCT: "ephyra",
      EPHYRA_DRAFT: "fake",
    }),
    {
      startJobs,
      accountStore: store,
      repository,
      notOrganicFetch: async (url, init) => {
        if (url.endsWith("/v1/judgement")) judgements.push(JSON.parse(String(init?.body ?? "{}")));
        const response = await fake.fetcher(url, init);
        if (url.endsWith("/v1/public/token") && response.ok)
          return json({ ...((await response.json()) as object), scope: grantedScope });
        return response;
      },
      providerFetch: async (url, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
        return respond(url, body);
      },
    },
  );
  cleanup.push(() => server.close());
  const login = async (did = ALICE, previousCookie?: string, setup = false) => {
    identity.did = did;
    const start = await server.app.request(`/auth/login${setup ? "?setup=1" : ""}`, {
      ...(previousCookie ? { headers: { cookie: previousCookie } } : {}),
    });
    expect(start.status).toBe(302);
    const authorize = start.headers.get("location")!;
    const loginCookie = start.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("ephyra_login="))!
      .split(";")[0]!;
    const callback = new URL(fake.approve(authorize));
    const finished = await server.app.request(`${callback.pathname}${callback.search}`, {
      headers: { cookie: loginCookie },
    });
    expect(finished.status).toBe(303);
    const cookie = finished.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${sessionCookieName(ORIGIN)}=`))!
      .split(";")[0]!;
    return { cookie, authorize };
  };
  return {
    server,
    store,
    calls,
    judgements,
    login,
    root,
    source,
    content,
    get fetches() {
      return fetches;
    },
    grant: (scope: string) => {
      grantedScope = scope;
    },
    respond: (next: typeof respond) => {
      respond = next;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function claimAgent(f: Fixture, cookie: string, scopes = ["bootstrap:read", "bootstrap:context", "bootstrap:run"]) {
  const registered = await f.server.app.request("/agent/identity", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "anonymous",
      intended_owner: ALICE, repository: { url: "https://git.example.org/acme/app.git", branch: "main" }, scopes }),
  });
  expect(registered.status).toBe(201);
  const registration = await registered.json();
  const initiated = await f.server.app.request("/agent/identity/claim", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_token: registration.claim_token, intended_owner: ALICE }),
  });
  expect(initiated.status).toBe(200);
  const attempt = (await initiated.json()).claim_attempt;
  const form = await f.server.app.request(attempt.verification_uri, { headers: { cookie } });
  expect(form.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await form.text())![1]!;
  const approved = await f.server.app.request("/agent/claim", { method: "POST",
    headers: { cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ attempt: new URL(attempt.verification_uri).searchParams.get("attempt")!, code: attempt.user_code, csrf }),
  });
  expect(approved.status).toBe(200);
  const response = await f.server.app.request("/oauth2/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: registration.claim_token }),
  });
  expect(response.status).toBe(200);
  const credential = await response.json();
  return { credential, registration, headers: { Authorization: `Bearer ${credential.access_token}` } };
}
const read = (f: Fixture, cookie: string, path: string, extra: Record<string, string> = {}) =>
  f.server.app.request(path, { headers: { cookie, ...extra } });
const settings = async (f: Fixture, cookie: string) => {
  const response = await read(f, cookie, "/v1/account");
  expect(response.status).toBe(200);
  return AccountSettings.parse(await response.json());
};
const write = (
  f: Fixture,
  cookie: string,
  did: string,
  workspace: string,
  path: string,
  body: unknown,
  key: string = crypto.randomUUID(),
  method = "PUT",
) =>
  f.server.app.request(path, {
    method,
    headers: {
      cookie,
      Origin: ORIGIN,
      "content-type": "application/json",
      "X-Ephyra-Account": did,
      "X-Ephyra-Workspace": workspace,
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });

/** Connects the fixture repository: drafting a policy needs one. Returns the settings of the new workspace. */
const connect = async (f: Fixture, cookie: string, did = ALICE) => {
  const current = await settings(f, cookie);
  const response = await write(f, cookie, did, current.workspaceId, "/v1/account/repository",
    { expectedVersion: current.version, url: "https://forge.example/team/project.git", branch: "main" }, `connect-${did}`);
  expect(response.status).toBe(200);
  return AccountSettings.parse(await response.json());
};

describe("personal application account routes", () => {
  test("a new account without a repository shows no example policy, no trails and cannot draft one", async () => {
    const f = await fixture(true);
    const { cookie } = await f.login();
    const fresh = await settings(f, cookie);
    expect(fresh.repository).toBeNull();
    const headers = { "X-Ephyra-Workspace": fresh.workspaceId };
    expect(await (await read(f, cookie, "/v1/docs", headers)).json()).toEqual([]);
    for (const path of ["autonomy.md", "thresholds.yaml"]) expect((await read(f, cookie, `/v1/docs/${path}`, headers)).status).toBe(404);
    for (const path of ["/v1/trails", "/v1/inbox", "/v1/questions", "/v1/drafts", "/v1/activity", "/v1/runs"])
      expect(await (await read(f, cookie, path, headers)).json()).toEqual([]);
    expect(await (await read(f, cookie, "/v1/policy/active", headers)).json()).toBeNull();
    expect(await (await read(f, cookie, "/v1/setup", headers)).json()).toBeNull();
    const refused = await write(f, cookie, ALICE, fresh.workspaceId, "/v1/drafts", { path: "autonomy.md" }, "no-repo-draft", "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Connect a repository before drafting its policy." });
    const connected = await connect(f, cookie);
    const doc = PolicyDoc.parse(await (await read(f, cookie, "/v1/docs/autonomy.md", { "X-Ephyra-Workspace": connected.workspaceId })).json());
    expect(doc.content).toBe(f.content);
  });

  test("account settings require a human session; browser writes require Origin and current account binding", async () => {
    const f = await fixture();
    expect((await f.server.app.request("/v1/account")).status).toBe(401);
    expect(
      (
        await f.server.app.request("/v1/account", {
          headers: {
            Authorization: `Bearer ${SERVICE}`,
            "X-Ephyra-Principal": ALICE,
          },
        })
      ).status,
    ).toBe(403);
    const { cookie } = await f.login();
    const saved = await settings(f, cookie);
    expect(saved.did).toBe(ALICE);
    expect((await read(f, cookie, "/v1/account", { "X-Ephyra-Account": BOB })).status).toBe(409);
    for (const origin of [undefined, "null", "https://other.example", `${ORIGIN}.attacker.example`]) {
      const result = await f.server.app.request("/v1/account/onboarding", {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 0, action: "skip" }),
        headers: {
          cookie,
          ...(origin ? { Origin: origin } : {}),
          "content-type": "application/json",
          "X-Ephyra-Account": ALICE,
          "Idempotency-Key": "origin-check-0001",
        },
      });
      expect(result.status).toBe(403);
    }
    for (const did of [undefined, BOB]) {
      const result = await f.server.app.request("/v1/account/onboarding", {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: 0, action: "skip" }),
        headers: {
          cookie,
          Origin: ORIGIN,
          ...(did ? { "X-Ephyra-Account": did } : {}),
          "Idempotency-Key": "account-check-0001",
        },
      });
      expect(result.status).toBe(409);
    }
    expect((await settings(f, cookie)).version).toBe(0);
  });

  test("two signed-in people have separate settings, drafts and usage, with stale workspace requests refused", async () => {
    const f = await fixture(true);
    const a = await f.login();
    const b = await f.login(BOB);
    const sa = await connect(f, a.cookie);
    const sb = await connect(f, b.cookie, BOB);
    expect(sa.workspaceId).not.toBe(sb.workspaceId);
    const created = await write(
      f,
      a.cookie,
      ALICE,
      sa.workspaceId,
      "/v1/drafts",
      { path: "autonomy.md" },
      "same-draft-key",
      "POST",
    );
    expect(created.status).toBe(200);
    const draft = Draft.parse(await created.json());
    expect(draft.createdBy).toBe(ALICE);
    expect(await (await read(f, b.cookie, "/v1/drafts")).json()).toEqual([]);
    expect((await read(f, b.cookie, `/v1/drafts/${draft.id}`)).status).toBe(404);
    expect((await read(f, b.cookie, "/v1/drafts", { "X-Ephyra-Workspace": sa.workspaceId })).status).toBe(409);
    expect(
      (await write(f, b.cookie, BOB, sa.workspaceId, "/v1/drafts", { path: "autonomy.md" }, "same-draft-key", "POST"))
        .status,
    ).toBe(409);
    const own = await write(
      f,
      b.cookie,
      BOB,
      sb.workspaceId,
      "/v1/drafts",
      { path: "autonomy.md" },
      "same-draft-key",
      "POST",
    );
    expect(own.status).toBe(200);
    expect(Draft.parse(await own.json()).createdBy).toBe(BOB);
    const saved = await write(f, a.cookie, ALICE, sa.workspaceId, "/v1/account/model", {
      expectedVersion: sa.version,
      provider: "compatible",
      model: "chosen-model",
      baseUrl: "https://models.example/v1",
      apiKey: KEY,
    });
    expect(saved.status).toBe(200);
    expect((await settings(f, b.cookie)).model).toMatchObject({ provider: "none", keyConfigured: false });
    expect(((await (await read(f, b.cookie, "/v1/usage/entries")).json()) as { entries: unknown[] }).entries).toEqual(
      [],
    );
  });

  test("saved BYOK settings drive Velum's real adapter and attributed usage; repeated operations do not call twice", async () => {
    const f = await fixture(true);
    const { cookie } = await f.login();
    const before = await connect(f, cookie);
    const input = {
      expectedVersion: before.version,
      provider: "compatible",
      model: "chosen-model",
      baseUrl: "https://models.example/v1",
      apiKey: KEY,
    };
    const saved = await write(f, cookie, ALICE, before.workspaceId, "/v1/account/model", input, "model-save-0001");
    expect(saved.status).toBe(200);
    const publicJson = await saved.text();
    expect(publicJson).not.toContain(KEY);
    expect(
      (await write(f, cookie, ALICE, before.workspaceId, "/v1/account/model", input, "model-save-0001")).status,
    ).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(
      (
        await write(
          f,
          cookie,
          ALICE,
          before.workspaceId,
          "/v1/account/model",
          { ...input, apiKey: "different" },
          "model-save-0001",
        )
      ).status,
    ).toBe(409);
    const draftResponse = await write(
      f,
      cookie,
      ALICE,
      before.workspaceId,
      "/v1/drafts",
      { path: "autonomy.md" },
      "draft-open-0001",
      "POST",
    );
    const draft = Draft.parse(await draftResponse.json());
    f.respond((url, body) =>
      url.endsWith("/models")
        ? json({ data: [{ id: "chosen-model" }] })
        : json({
            model: "provider-confirmed-model",
            choices: [{ message: { content: JSON.stringify({ text: `Echo: ${KEY}` }) } }],
            usage: { total_tokens: 11, cost: 123 },
          }),
    );
    const replyPath = `/v1/drafts/${draft.id}/messages`;
    const reply = await write(
      f,
      cookie,
      ALICE,
      before.workspaceId,
      replyPath,
      { text: "Help write this policy." },
      "draft-chat-0001",
      "POST",
    );
    expect(reply.status).toBe(200);
    const repliedJson = await reply.text();
    expect(repliedJson).not.toContain(KEY);
    const assistant = Draft.parse(JSON.parse(repliedJson)).messages.find((message) => message.role === "persona");
    expect(assistant?.usage).toMatchObject({ engine: "provider-confirmed-model", tokens: 11, costMicrousd: null });
    const request = f.calls.find((call) => call.method === "POST")!;
    expect(request.url).toBe("https://models.example/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.body).toMatchObject({ model: "chosen-model", max_tokens: 4096 });
    expect(request.body).not.toHaveProperty("max_completion_tokens");
    expect(
      (
        await write(
          f,
          cookie,
          ALICE,
          before.workspaceId,
          replyPath,
          { text: "Help write this policy." },
          "draft-chat-0001",
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const usage = (await (await read(f, cookie, "/v1/usage/entries")).json()) as { entries: UsageEntry[] };
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({
      billedTo: "byok",
      persona: "velum",
      outcome: "ok",
      costMicrousd: null,
      tokens: 11,
      engine: "provider-confirmed-model",
    });
    expect(JSON.stringify(usage)).not.toContain(KEY);
  });

  test("Anthropic selection reaches the selected messages endpoint with its own authentication protocol", async () => {
    const f = await fixture(true);
    const { cookie } = await f.login();
    const before = await connect(f, cookie);
    expect(
      (
        await write(f, cookie, ALICE, before.workspaceId, "/v1/account/model", {
          expectedVersion: before.version,
          provider: "anthropic",
          model: "chosen-model",
          baseUrl: "https://anthropic-compatible.example/v1",
          apiKey: KEY,
        })
      ).status,
    ).toBe(200);
    const d = Draft.parse(
      await (
        await write(
          f,
          cookie,
          ALICE,
          before.workspaceId,
          "/v1/drafts",
          { path: "autonomy.md" },
          "anthropic-draft",
          "POST",
        )
      ).json(),
    );
    const reply = await write(
      f,
      cookie,
      ALICE,
      before.workspaceId,
      `/v1/drafts/${d.id}/messages`,
      { text: "Draft a policy." },
      "anthropic-chat",
      "POST",
    );
    expect(reply.status).toBe(200);
    const request = f.calls.find((call) => call.method === "POST")!;
    expect(request.url).toBe("https://anthropic-compatible.example/v1/messages");
    expect(request.headers.get("x-api-key")).toBe(KEY);
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(request.body?.model).toBe("chosen-model");
  });

  test("a fetched repository supplies docs; reconnect refreshes them and changing repositories invalidates old workspace headers", async () => {
    const f = await fixture(true);
    const { cookie } = await f.login();
    const before = await settings(f, cookie);
    const url = "https://forge.example/team/project.git";
    const response = await write(
      f,
      cookie,
      ALICE,
      before.workspaceId,
      "/v1/account/repository",
      { expectedVersion: 0, url, branch: "main", token: KEY },
      "repo-connect-0001",
    );
    expect(response.status).toBe(200);
    const connected = AccountSettings.parse(await response.json());
    expect(connected.workspaceId).not.toBe(before.workspaceId);
    expect((await read(f, cookie, "/v1/docs", { "X-Ephyra-Workspace": before.workspaceId })).status).toBe(409);
    const doc = PolicyDoc.parse(await (await read(f, cookie, "/v1/docs/autonomy.md")).json());
    expect(doc.content).toBe(f.content);
    const updated = `${AUTONOMY_TEMPLATE}\n# Repository updated since setup.\n`;
    await writeFile(join(f.source, "autonomy.md"), updated);
    expect(localGit(["commit", "--quiet", "-am", "update offline fixture"], f.source).code).toBe(0);
    expect(
      (
        await write(
          f,
          cookie,
          ALICE,
          connected.workspaceId,
          "/v1/account/repository",
          { expectedVersion: 1, url, branch: "main" },
          "repo-refresh-0002",
        )
      ).status,
    ).toBe(200);
    expect(PolicyDoc.parse(await (await read(f, cookie, "/v1/docs/autonomy.md")).json()).content).toBe(updated);
    expect(f.fetches).toBe(2);
    const switched = await write(
      f,
      cookie,
      ALICE,
      connected.workspaceId,
      "/v1/account/repository",
      { expectedVersion: 2, url: "https://forge.example/team/other.git", branch: "main" },
      "repo-switch-0003",
    );
    expect(switched.status).toBe(200);
    expect(AccountSettings.parse(await switched.json()).repository?.credentialConfigured).toBe(false);
    expect(
      (
        await write(
          f,
          cookie,
          ALICE,
          connected.workspaceId,
          "/v1/drafts",
          { path: "autonomy.md" },
          "stale-repo-draft",
          "POST",
        )
      ).status,
    ).toBe(409);
  });

  test("hosted-model permission requests add only the signed-in account's selected scope and clear after reauthentication", async () => {
    const f = await fixture();
    const a = await f.login();
    const before = await settings(f, a.cookie);
    const saved = await write(f, a.cookie, ALICE, before.workspaceId, "/v1/account/model", {
      expectedVersion: 0,
      provider: "notorganic",
      model: "hosted-selected",
    });
    expect(saved.status).toBe(200);
    expect(AccountSettings.parse(await saved.json()).model.status).toBe("needs_sign_in");
    await expect(f.server.accounts!.modelFor(ALICE, before.workspaceId)).rejects.toThrow("signing in again");
    f.grant("judgement:evaluate infer:hosted-selected");
    const reauthenticated = await f.login(ALICE, a.cookie, true);
    expect(new URL(reauthenticated.authorize).searchParams.get("scope")?.split(" ")).toContain("infer:hosted-selected");
    expect((await settings(f, reauthenticated.cookie)).model.status).toBe("saved");
    expect((await f.server.accounts!.modelFor(ALICE, before.workspaceId))?.kind).toBe("notorganic");
    const b = await f.login(BOB);
    const bobSetup = await f.server.app.request("/auth/login?setup=1", { headers: { cookie: b.cookie } });
    expect(new URL(bobSetup.headers.get("location")!).searchParams.get("scope")).not.toContain("infer:hosted-selected");
    expect(f.calls).toHaveLength(0);
  });

  test("knowledge onboarding is account-bound, optional, versioned, and requests scopes through real reauthorization", async () => {
    const f = await fixture();
    expect((await f.server.app.request("/v1/account/knowledge")).status).toBe(401);
    expect((await f.server.app.request("/v1/account/knowledge", { headers: {
      Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": ALICE,
    } })).status).toBe(403);
    const a = await f.login();
    const before = await settings(f, a.cookie);
    const path = "/v1/account/knowledge";
    expect(await (await read(f, a.cookie, path)).json()).toMatchObject({ status: "disabled", sources: [] });
    const input = { expectedVersion: before.version, workspaceId: before.workspaceId, enabled: true, sources: [] };
    expect((await write(f, a.cookie, BOB, before.workspaceId, path, input)).status).toBe(409);
    const saved = await write(f, a.cookie, ALICE, before.workspaceId, path, input, "knowledge-opt-in");
    expect(saved.status).toBe(200);
    const next = AccountSettings.parse(await saved.json());
    expect(next.knowledge).toMatchObject({ enabled: true, sources: [], workspaceId: before.workspaceId });
    expect((await write(f, a.cookie, ALICE, before.workspaceId, path, input, "knowledge-opt-in")).status).toBe(200);
    expect(await (await read(f, a.cookie, path)).json()).toMatchObject({ status: "needs_sign_in" });
    f.grant("judgement:evaluate knowledge:read knowledge:tools");
    const renewed = await f.login(ALICE, a.cookie, true);
    expect(new URL(renewed.authorize).searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["knowledge:read", "knowledge:tools"]));
    // The fictional upstream has no catalog configured: this remains unavailable rather than inventing sources.
    expect(await (await read(f, renewed.cookie, path)).json()).toMatchObject({ status: "unavailable", sources: [] });
    const b = await f.login(BOB);
    const bobSetup = await f.server.app.request("/auth/login?setup=1", { headers: { cookie: b.cookie } });
    expect(new URL(bobSetup.headers.get("location")!).searchParams.get("scope")).not.toContain("knowledge:");
    expect(await (await read(f, b.cookie, path)).json()).toMatchObject({ status: "disabled" });
    expect((await write(f, renewed.cookie, ALICE, next.workspaceId, path, {
      expectedVersion: next.version, workspaceId: next.workspaceId, enabled: false, sources: [],
    })).status).toBe(200);
    expect(await f.server.accounts!.scopes(ALICE)).not.toContain("knowledge:read");
  });
});


/** Explicitly seeded offline question evidence; real journal/sealing/HTTP authorization are exercised. */
async function seedQuestion(
  f: Fixture,
  cookie: string,
  account: AccountSettings,
  recipient: InvestigationContact = ownerContact(account.did),
) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const questionId = id.replaceAll("-", "").repeat(2);
  // Initialize the personal runtime and mirror without starting any background job.
  const ready = await read(f, cookie, `/v1/questions/${id}/${questionId}`, { "X-Ephyra-Workspace": account.workspaceId });
  expect(ready.status).toBe(200);
  expect(await ready.json()).toBeNull();
  const journal = new GitJournal({
    gitDir: join(f.server.accounts!.directory(account.workspaceId), "workspace.git"),
    clock: { now: () => new Date(now) },
  });
  const trail = Trail.parse({
    schema: 1, id, short: "T-http-fixture", repo: account.workspaceId, title: "Recorded fixture cart failure", rev: 1,
    state: "parked", resumeTo: "researching", signals: [crypto.randomUUID()], area: "app", risk: "low", route: "auto_fix", severity: 2,
    base: { ref: "main", sha: "a".repeat(40) }, head: "b".repeat(40), checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 3 },
    budget: { tokensUsed: 0, tokensMax: 1000, wallclockMaxS: 60, spendMicrousdUsed: 0, spendMicrousdMax: 1000 },
    createdAt: now, updatedAt: now,
  });
  const question = InvestigationQuestion.parse({
    id: questionId, trailId: trail.id, workspaceId: account.workspaceId, bound: { rev: 1, head: trail.head },
    status: "awaiting_answer", question: "Fixture: should the cart retain items after sign-in?",
    reason: "Fixture: expected behavior is missing from the recorded report.", acceptance: "State whether cart items are retained.",
    recipient, createdAt: now, updatedAt: now,
    delivery: { kind: recipient.did === account.did ? "inbox" : "webhook", status: "sent", receipt: "offline-fixture" },
    checks: [{ phase: "question", model: "offline-fixture", accepted: true, request: { fixture: true }, response: { fixture: true } }],
  });
  await journal.create(trail, {
    schema: 1, id: crypto.randomUUID(), trail: trail.id, rev: 1, at: now, actor: { kind: "system", id: "offline-http-fixture" },
    type: "trail_created", data: { signalId: trail.signals[0]!, title: trail.title, baseRef: "main", baseSha: trail.base.sha },
  }, { [`questions/${question.id}.json`]: JSON.stringify(question), "questions/latest.json": JSON.stringify(question) });
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 9).toString("base64"));
  const claims: AnswerTicket = { kind: "investigation-answer-v1", did: account.did, workspace: account.workspaceId,
    trail: trail.id, question: question.id, recipient: recipient.id, expires: Date.now() + 60_000 };
  const token = await box.seal(claims);
  return { journal, trail, question, box, claims, token,
    path: `/v1/questions/${trail.id}/${question.id}`, answerPath: `/v1/questions/${trail.id}/${question.id}/answer` };
}

const callback = (f: Fixture, token: string, method = "GET", text?: string, headers: Record<string, string> = {}) =>
  f.server.app.request("/callbacks/investigation", {
    method, headers: { Authorization: `Bearer ${token}`, ...(text === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
  });

const postHogEmpty = () => json({
  columns: ["id", "timestamp", "event", "exception_list", "fingerprint", "level", "session_id", "steps"],
  results: [], is_cached: false, last_refresh: new Date().toISOString(),
});

describe("telemetry, people and investigation HTTP routes", () => {
  test("settings writes bind human account, current body workspace, optional workspace header and browser Origin", async () => {
    const f = await fixture();
    const { cookie } = await f.login();
    for (const kind of ["telemetry", "people"] as const) {
      const account = await settings(f, cookie);
      const path = `/v1/account/${kind}`;
      const input = kind === "telemetry"
        ? { expectedVersion: account.version, workspaceId: account.workspaceId, enabled: false,
          origin: "", projectId: "", includeRecordings: false }
        : { expectedVersion: account.version, workspaceId: account.workspaceId, enabled: false, contacts: [ownerContact(ALICE)] };
      expect((await f.server.app.request(path, { method: "PUT", body: JSON.stringify(input) })).status).toBe(401);
      expect((await f.server.app.request(path, { method: "PUT", body: JSON.stringify(input), headers: {
        Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": ALICE,
      } })).status).toBe(403);
      for (const origin of [undefined, "null", "https://other.example", `${ORIGIN}.attacker.example`]) {
        const response = await f.server.app.request(path, { method: "PUT", body: JSON.stringify(input), headers: {
          cookie, ...(origin === undefined ? {} : { Origin: origin }), "content-type": "application/json",
          "X-Ephyra-Account": ALICE, "X-Ephyra-Workspace": account.workspaceId, "Idempotency-Key": crypto.randomUUID(),
        } });
        expect(response.status).toBe(403);
      }
      expect((await write(f, cookie, BOB, account.workspaceId, path, input)).status).toBe(409);
      expect((await write(f, cookie, ALICE, account.workspaceId, path,
        { ...input, workspaceId: "ws_stale" })).status).toBe(409);
      expect((await write(f, cookie, ALICE, "ws_stale", path, input)).status).toBe(409);
      expect((await settings(f, cookie)).version).toBe(account.version);
      // AccountClient intentionally carries workspace in the body, so omitting its optional header is supported.
      const saved = await f.server.app.request(path, { method: "PUT", body: JSON.stringify(input), headers: {
        cookie, Origin: ORIGIN, "content-type": "application/json", "X-Ephyra-Account": ALICE,
        "Idempotency-Key": crypto.randomUUID(),
      } });
      expect(saved.status).toBe(200);
      expect(AccountSettings.parse(await saved.json()).version).toBe(account.version + 1);
    }
    expect(f.calls).toHaveLength(0); expect(f.judgements).toHaveLength(0);
  });

  test("PostHog credentials remain account-scoped, sealed and absent from settings; replays do not re-query", async () => {
    const f = await fixture(); f.respond(() => postHogEmpty());
    const alice = await f.login(); const bob = await f.login(BOB);
    const a = await settings(f, alice.cookie); const b = await settings(f, bob.cookie);
    const input = { expectedVersion: a.version, workspaceId: a.workspaceId, enabled: true,
      origin: "https://us.posthog.com", projectId: "42", includeRecordings: false, apiKey: KEY };
    const saved = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/telemetry", input, "telemetry-connect-one");
    expect(saved.status).toBe(200);
    const publicText = await saved.text();
    expect(publicText).not.toContain(KEY);
    const next = AccountSettings.parse(JSON.parse(publicText));
    expect(next.telemetry).toMatchObject({ enabled: true, projectId: "42", keyConfigured: true, status: "verified" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://us.posthog.com/api/projects/42/query/");
    expect(f.calls[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect((await f.store.get(ALICE))!.telemetryKey).not.toContain(KEY);
    expect((await settings(f, bob.cookie)).telemetry).toBeUndefined();
    expect(await f.server.accounts!.telemetryFor(BOB, a.workspaceId)).toBeNull();
    expect(await f.server.accounts!.telemetryFor(ALICE, b.workspaceId)).toBeNull();
    expect((await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/telemetry", input, "telemetry-connect-one")).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect((await write(f, bob.cookie, BOB, b.workspaceId, "/v1/account/telemetry", { ...input, workspaceId: a.workspaceId })).status).toBe(409);
    const disconnected = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/telemetry", {
      ...input, expectedVersion: next.version, enabled: false, clearKey: true, apiKey: undefined,
    });
    expect(disconnected.status).toBe(200); expect(await f.server.accounts!.telemetryFor(ALICE, a.workspaceId)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  test("delivery bridge settings are isolated and neither their credential nor another account's contact appears publicly", async () => {
    const f = await fixture(); const alice = await f.login(); const bob = await f.login(BOB);
    const a = await settings(f, alice.cookie); const b = await settings(f, bob.cookie);
    const contact: InvestigationContact = { id: "product-contact", alias: "Product teammate", roles: ["product"], areas: ["app"] };
    const input = { expectedVersion: a.version, workspaceId: a.workspaceId, enabled: true, contacts: [contact],
      webhookUrl: "https://bridge.example.com/questions", token: KEY };
    const response = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/people", input, "people-connect-one");
    expect(response.status).toBe(200);
    const publicText = await response.text(); expect(publicText).not.toContain(KEY);
    expect(AccountSettings.parse(JSON.parse(publicText)).people).toMatchObject({ contacts: [contact], keyConfigured: true });
    expect((await f.store.get(ALICE))!.peopleToken).not.toContain(KEY);
    expect((await settings(f, bob.cookie)).people!.contacts).toEqual([ownerContact(BOB)]);
    expect(await f.server.accounts!.peopleFor(BOB, a.workspaceId)).toBeNull();
    expect(await f.server.accounts!.peopleFor(ALICE, b.workspaceId)).toBeNull();
    expect((await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/people", input, "people-connect-one")).status).toBe(200);
    expect(f.calls).toHaveLength(0);
  });

  test("exact question reads and cookie answers enforce workspace, account and Origin bindings", async () => {
    const f = await fixture(); const alice = await f.login(); const bob = await f.login(BOB);
    const a = await settings(f, alice.cookie); const b = await settings(f, bob.cookie);
    const q = await seedQuestion(f, alice.cookie, a);
    expect((await f.server.app.request(q.path)).status).toBe(401);
    expect((await f.server.app.request(q.path, { headers: {
      Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": ALICE, "X-Ephyra-Workspace": a.workspaceId,
    } })).status).toBe(403);
    expect((await read(f, alice.cookie, q.path)).status).toBe(409);
    expect((await read(f, alice.cookie, q.path, { "X-Ephyra-Workspace": b.workspaceId })).status).toBe(409);
    const own = await read(f, alice.cookie, q.path, { "X-Ephyra-Workspace": a.workspaceId });
    expect(own.status).toBe(200); expect(InvestigationQuestion.parse(await own.json()).id).toBe(q.question.id);
    const other = await read(f, bob.cookie, q.path, { "X-Ephyra-Workspace": b.workspaceId });
    expect(other.status).toBe(200); expect(await other.json()).toBeNull();
    expect((await write(f, alice.cookie, ALICE, b.workspaceId, q.answerPath, { text: "Retain cart items" }, undefined, "POST")).status).toBe(409);
    expect((await write(f, alice.cookie, BOB, a.workspaceId, q.answerPath, { text: "Retain cart items" }, undefined, "POST")).status).toBe(409);
    for (const origin of [undefined, "null", "https://other.example"]) {
      const response = await f.server.app.request(q.answerPath, { method: "POST", body: JSON.stringify({ text: "Retain cart items" }), headers: {
        cookie: alice.cookie, ...(origin === undefined ? {} : { Origin: origin }), "content-type": "application/json",
        "X-Ephyra-Account": ALICE, "X-Ephyra-Workspace": a.workspaceId,
      } });
      expect(response.status).toBe(403);
    }
    expect(f.judgements).toHaveLength(0);
    const answer = await write(f, alice.cookie, ALICE, a.workspaceId, q.answerPath, { text: "Retain cart items" }, undefined, "POST");
    expect(answer.status).toBe(200);
    // The injected gateway returns a non-choice result: authorization succeeds but evidence acceptance fails closed.
    expect(InvestigationQuestion.parse(await answer.json()).status).toBe("rejected");
    expect(f.judgements).toHaveLength(1);
  });

  test("rejected service-token answers cannot create a personal account record", async () => {
    const f = await fixture();
    expect(await f.store.get(BOB)).toBeNull();
    const response = await f.server.app.request(`/v1/questions/${crypto.randomUUID()}/${"a".repeat(64)}/answer`, {
      method: "POST", body: JSON.stringify({ text: "An unauthorized service reply" }), headers: {
        Authorization: `Bearer ${SERVICE}`, "X-Ephyra-Principal": BOB, "X-Ephyra-Workspace": "ws_stale",
        "content-type": "application/json",
      },
    });
    expect([403, 409]).toContain(response.status);
    expect(await f.store.get(BOB)).toBeNull();
    expect(f.judgements).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  test("a person cannot answer a question addressed to another recipient, even in their own workspace", async () => {
    const f = await fixture(); const alice = await f.login(); const bob = await f.login(BOB);
    const a = await settings(f, alice.cookie); const b = await settings(f, bob.cookie);
    const recipient: InvestigationContact = { id: "bob-contact", alias: "Bob teammate", roles: ["maintainer"], areas: ["app"], did: BOB };
    expect((await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/people", {
      expectedVersion: a.version, workspaceId: a.workspaceId, enabled: true, contacts: [recipient],
      webhookUrl: "https://bridge.example.com/questions", token: KEY,
    })).status).toBe(200);
    const q = await seedQuestion(f, alice.cookie, a, recipient);
    expect((await write(f, alice.cookie, ALICE, a.workspaceId, q.answerPath, { text: "Retain items" }, undefined, "POST")).status).toBe(403);
    expect((await write(f, bob.cookie, BOB, b.workspaceId, q.answerPath, { text: "Retain items" }, undefined, "POST")).status).toBe(403);
    expect((await write(f, bob.cookie, BOB, a.workspaceId, q.answerPath, { text: "Retain items" }, undefined, "POST")).status).toBe(409);
    expect(f.judgements).toHaveLength(0);
  });

  test("sealed answer tickets authorize only their recorded recipient and bind GET/POST while rejecting untrusted Origins", async () => {
    const f = await fixture(); const alice = await f.login(); const a = await settings(f, alice.cookie);
    const q = await seedQuestion(f, alice.cookie, a);
    expect((await f.server.app.request("/callbacks/investigation")).status).toBe(422);
    expect((await f.server.app.request(`/callbacks/investigation?token=${q.token}`)).status).toBe(422);
    for (const method of ["GET", "POST"]) {
      expect((await callback(f, q.token, method, method === "POST" ? "Retain cart items" : undefined,
        { Origin: "https://other.example" })).status).toBe(403);
      expect((await callback(f, q.token, method, method === "POST" ? "Retain cart items" : undefined,
        { Origin: "null" })).status).toBe(403);
    }
    const shown = await callback(f, q.token);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ question: q.question.question, reason: q.question.reason, status: "awaiting_answer" });
    expect(f.judgements).toHaveLength(0);
    const result = await callback(f, q.token, "POST", "Retain cart items", { Origin: ORIGIN });
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ status: "rejected" });
    expect(f.judgements).toHaveLength(1);
    expect((await callback(f, q.token, "POST", "Retain cart items", { Origin: ORIGIN })).status).toBe(200);
    expect(f.judgements).toHaveLength(1);
    expect((await callback(f, q.token, "POST", "A different answer", { Origin: ORIGIN })).status).toBe(422);
    const wrongRecipient = await q.box.seal({ ...q.claims, recipient: "somebody-else" });
    const wrongAccount = await q.box.seal({ ...q.claims, did: BOB });
    expect((await callback(f, wrongRecipient)).status).toBe(403);
    expect((await callback(f, wrongAccount)).status).toBe(409);
    expect(f.calls).toHaveLength(0);
  });

  test("expired, tampered and incorrectly sealed tickets cannot read or answer questions", async () => {
    const f = await fixture(); const alice = await f.login(); const a = await settings(f, alice.cookie);
    const q = await seedQuestion(f, alice.cookie, a);
    const expired = await q.box.seal({ ...q.claims, expires: Date.now() - 1 });
    const otherBox = await SecretBox.fromBase64(Buffer.alloc(32, 3).toString("base64"));
    const wrongKey = await otherBox.seal(q.claims);
    const tampered = q.token.slice(0, 20) + (q.token[20] === "A" ? "B" : "A") + q.token.slice(21);
    for (const token of [expired, wrongKey, tampered]) {
      for (const method of ["GET", "POST"]) {
        const response = await callback(f, token, method, method === "POST" ? "Retain items" : undefined, { Origin: ORIGIN });
        expect(response.status).toBe(422);
        const body = await response.text(); expect(body).not.toContain(q.question.question); expect(body).not.toContain(token);
      }
    }
    expect(f.judgements).toHaveLength(0);
  });

  test("reassigning a configured recipient ID revokes an older ticket for both reads and answers", async () => {
    const f = await fixture(); const alice = await f.login(); const a = await settings(f, alice.cookie);
    const q = await seedQuestion(f, alice.cookie, a);
    expect((await callback(f, q.token)).status).toBe(200);
    const reassigned: InvestigationContact = { ...ownerContact(BOB), alias: "Replacement maintainer" };
    const response = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/people", {
      expectedVersion: a.version, workspaceId: a.workspaceId, enabled: true, contacts: [reassigned],
      webhookUrl: "https://bridge.example.com/questions", token: KEY,
    });
    expect(response.status).toBe(200);
    for (const method of ["GET", "POST"]) {
      expect((await callback(f, q.token, method, method === "POST" ? "Retain items" : undefined, { Origin: ORIGIN })).status).toBe(403);
    }
    expect(f.judgements).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  test("switching repositories invalidates old answer tickets and stale question workspace headers", async () => {
    const f = await fixture(true); const alice = await f.login(); const a = await settings(f, alice.cookie);
    const q = await seedQuestion(f, alice.cookie, a);
    const switched = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/repository", {
      expectedVersion: a.version, url: "https://forge.example/team/next.git", branch: "main",
    }, "question-workspace-switch");
    expect(switched.status).toBe(200);
    const next = AccountSettings.parse(await switched.json());
    expect(next.workspaceId).not.toBe(a.workspaceId);
    expect((await callback(f, q.token)).status).toBe(409);
    expect((await callback(f, q.token, "POST", "Retain items", { Origin: ORIGIN })).status).toBe(409);
    expect((await read(f, alice.cookie, q.path, { "X-Ephyra-Workspace": a.workspaceId })).status).toBe(409);
    expect((await write(f, alice.cookie, ALICE, a.workspaceId, q.answerPath, { text: "Retain items" }, undefined, "POST")).status).toBe(409);
    const current = await read(f, alice.cookie, q.path, { "X-Ephyra-Workspace": next.workspaceId });
    expect(current.status).toBe(200); expect(await current.json()).toBeNull();
    expect(f.judgements).toHaveLength(0);
  });
});

describe("agent-led proactive setup", () => {
  test("a claimed agent can bootstrap before incidents but cannot use human or arbitrary capability routes", async () => {
    const f = await fixture(true, true);
    const alice = await f.login();
    const bob = await f.login(BOB);
    const discovery = await f.server.app.request("/.well-known/oauth-protected-resource");
    expect((await discovery.json()).resource).toBe(`${ORIGIN}/v1/agent/`);
    expect((await f.server.app.request("/auth/session")).headers.get("Content-Security-Policy")).toBeNull();
    expect((await f.server.app.request("/v1/agent/setup")).headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
    const agent = await claimAgent(f, alice.cookie);
    const a = await settings(f, alice.cookie);
    expect(a.repository?.url).toBe("https://git.example.org/acme/app.git");
    expect((await settings(f, bob.cookie)).repository).toBeNull();
    for (const path of ["/v1/account", "/v1/trails", "/v1/account/agents", "/v1/setup"])
      expect((await f.server.app.request(path, { headers: { ...agent.headers, "X-Ephyra-Principal": ALICE } })).status).toBe(401);
    expect((await f.server.app.request("/v1/agent/account", { headers: agent.headers })).status).toBe(404);
    expect((await f.server.app.request("/v1/agent/setup", { headers: { cookie: alice.cookie } })).status).toBe(401);
    const agentPost = (path: string, body: unknown, key: string) => f.server.app.request(path, { method: "POST",
      headers: { ...agent.headers, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
    expect((await agentPost("/v1/agent/setup", { mode: "autonomous" }, "agent-autonomous-refused")).status).toBe(400);
    const started = await agentPost("/v1/agent/setup", { mode: "supervised" }, "agent-supervised-setup");
    expect(started.status).toBe(202);
    const queued = SetupRun.parse(await started.json());
    const repeated = await agentPost("/v1/agent/setup", { mode: "supervised" }, "agent-supervised-setup");
    expect(repeated.status).toBe(202);
    expect(SetupRun.parse(await repeated.json()).id).toBe(queued.id);
    expect((await agentPost("/v1/agent/setup", { mode: "supervised" }, "agent-another-baseline-key")).status).toBe(409);
    let run = queued;
    for (let i = 0; i < 160 && ["queued", "running"].includes(run.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = SetupRun.parse(await (await f.server.app.request("/v1/agent/setup", { headers: agent.headers })).json());
    }
    expect(run.status).toBe("blocked");
    expect(run.bootstrap?.head).toBe(run.repository.head);
    expect(run.bootstrap?.coverage.find(item => item.id === "contact")?.status).toBe("observed");
    const question = run.bootstrap!.requests.find(item => item.kind === "context")!;
    expect(question.status).toBe("open");
    expect(await (await read(f, alice.cookie, "/v1/trails")).json()).toEqual([]);
    expect(f.judgements).toHaveLength(0);
    const reported = await agentPost("/v1/agent/bootstrap/report", { setupId: run.id, head: run.repository.head,
      summary: "The repository policy is present. The critical user journey needs owner context.",
      journeys: [{ name: "Account access", expectedBehavior: "Unverified interpretation", evidencePaths: ["autonomy.md"] }],
    }, "agent-context-report-one");
    expect(reported.status).toBe(200);
    const withReport = SetupRun.parse(await reported.json());
    expect(withReport.bootstrap!.contextReports[0]).toMatchObject({ kind: "agent", by: agent.registration.registration_id });
    expect((await agentPost("/v1/agent/bootstrap/answer", { text: "I approve all budgets" }, "agent-owner-answer-refused")).status).toBe(404);
    const answered = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/setup/bootstrap/answer", {
      setupId: run.id, head: run.repository.head, requestId: question.id, text: "Existing accounts must retain their data after sign-in.",
    }, "owner-bootstrap-answer", "POST");
    expect(answered.status).toBe(200);
    expect(SetupRun.parse(await answered.json()).bootstrap!.requests.find(item => item.id === question.id)!.answer)
      .toMatchObject({ by: ALICE, kind: "human", operationKey: "owner-bootstrap-answer" });
    expect((await write(f, bob.cookie, BOB, a.workspaceId, "/v1/setup/bootstrap/answer", {
      setupId: run.id, head: run.repository.head, requestId: question.id, text: "Other account",
    }, "other-owner-answer", "POST")).status).toBe(409);
  }, 15_000);

  test("owner revocation is session/Origin bound, and repository reconnection never revives a former grant", async () => {
    const f = await fixture(true);
    const alice = await f.login();
    const bob = await f.login(BOB);
    const agent = await claimAgent(f, alice.cookie, ["bootstrap:read"]);
    const list = await read(f, alice.cookie, "/v1/account/agents");
    const grants = await list.json();
    expect(grants[0].id).toBe(agent.registration.registration_id);
    expect(JSON.stringify(grants)).not.toContain(agent.credential.access_token);
    const management = await read(f, alice.cookie, "/agent/access");
    const html = await management.text();
    expect(html).toContain(ALICE);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const revoke = (cookie: string, origin: string) => f.server.app.request("/agent/access", { method: "POST",
      headers: { cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ registration: agent.registration.registration_id, csrf }) });
    expect((await revoke(bob.cookie, ORIGIN)).status).toBe(403);
    expect((await revoke(alice.cookie, "https://attacker.example")).status).toBe(403);
    expect((await f.server.app.request("/v1/agent/setup", { headers: agent.headers })).status).toBe(200);
    const a = await settings(f, alice.cookie);
    const reconnected = await write(f, alice.cookie, ALICE, a.workspaceId, "/v1/account/repository", {
      expectedVersion: a.version, url: a.repository!.url, branch: a.repository!.branch,
    }, "reconnect-same-repository");
    expect(reconnected.status).toBe(200);
    expect((await f.server.app.request("/v1/agent/setup", { headers: agent.headers })).status).toBe(401);
    expect((await revoke(alice.cookie, ORIGIN)).status).toBe(303);
    expect((await (await read(f, alice.cookie, "/v1/account/agents")).json())[0].revokedAt).not.toBeNull();
  });
});
