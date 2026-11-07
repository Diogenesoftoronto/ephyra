import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AccountSettings, Draft, PolicyDoc, type UsageEntry } from "@ephyra/core";
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

async function fixture(withRepository = false) {
  const root = await mkdtemp(join(tmpdir(), "ephyra-account-http-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = { approved: true, product: "ephyra", did: ALICE };
  const fake = fakeNotOrganic(identity);
  let grantedScope = "judgement:evaluate";
  const calls: { url: string; method: string; headers: Headers; body: Record<string, unknown> | null }[] = [];
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
      if (args.includes("fetch")) {
        fetches++;
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
      startJobs: false,
      accountStore: store,
      repository,
      notOrganicFetch: async (url, init) => {
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

describe("personal application account routes", () => {
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
    const f = await fixture();
    const a = await f.login();
    const b = await f.login(BOB);
    const sa = await settings(f, a.cookie);
    const sb = await settings(f, b.cookie);
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
      expectedVersion: 0,
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
    const f = await fixture();
    const { cookie } = await f.login();
    const before = await settings(f, cookie);
    const input = {
      expectedVersion: 0,
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
    const f = await fixture();
    const { cookie } = await f.login();
    const before = await settings(f, cookie);
    expect(
      (
        await write(f, cookie, ALICE, before.workspaceId, "/v1/account/model", {
          expectedVersion: 0,
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
});
