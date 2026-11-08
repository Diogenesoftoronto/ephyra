// Offline browser regression: real server, PKCE callback, setup queue/Git records, cookies and policy drafts.
// Not Organic, repository transport and model provider use explicit fixtures; no hosted integration is claimed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { type Composed } from "../../server/src/compose.ts";
import { composeApplication } from "../../server/src/application.ts";
import { readConfig } from "../../server/src/config.ts";
import { fakeNotOrganic } from "../../server/src/auth/notorganic.fixture.ts";
import { createSite } from "../../web/src/site.ts";
import { launch } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/signin");
const dir = await mkdtemp(join(tmpdir(), "ephyra-browser-signin-"));
const did = "did:plc:approver123";
const knowledgeSource = {
  id: "project-notes", provider: "remote-mcp", label: "Offline project notes", resources_allowed: true,
  tools: [{ name: "search_notes", description: "Search the fictional project notes.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true } }],
};
let knowledgeLists = 0;
const account = {
  approved: true, product: "ephyra", did, honorRequestedScopes: true,
  knowledge: (path: string, _body: Record<string, unknown>, owner: string) => {
    assert.equal(path, "/v1/knowledge/sources", "onboarding only discovers sources; it does not execute tools");
    knowledgeLists++;
    return Response.json({ object: "list", data: owner === did ? [knowledgeSource] : [] });
  },
};
const provider = fakeNotOrganic(account);
const modelCalls: { authorization: string | null; model: string }[] = [];
const fixtureRepo = join(dir, "fixture-repository");
const fixtureUrl = "https://git.example.org/team/offline-application.git";
let fixtureHead = "";
let repositoryConnections = 0;
let setupId: string | undefined;
async function fixtureGit(args: string[], cwd: string) {
  const process = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: Bun.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Offline fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Offline fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  assert.equal(code, 0, `offline fixture git ${args[0]} failed: ${error}`);
  return output.trim();
}
let app: Composed | undefined;
let browser: Browser | undefined;
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });
const origin = http.url.origin;
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });

try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(fixtureRepo);
  await fixtureGit(["init", "--quiet", "--initial-branch=fixture-default"], fixtureRepo);
  await writeFile(join(fixtureRepo, "package.json"), JSON.stringify({
    name: "offline-browser-fixture", scripts: { test: "bun test", typecheck: "tsc --noEmit" },
  }));
  await writeFile(join(fixtureRepo, "README.md"), "# Offline browser fixture\nNo repository script is executed by setup.\n");
  await fixtureGit(["add", "package.json", "README.md"], fixtureRepo);
  await fixtureGit(["commit", "--quiet", "-m", "Offline fixture baseline"], fixtureRepo);
  fixtureHead = await fixtureGit(["rev-parse", "HEAD"], fixtureRepo);
  app = await composeApplication(
    readConfig({
      EPHYRA_API_TOKEN: "offline-browser-service-token",
      EPHYRA_DATA_DIR: dir,
      EPHYRA_PUBLIC_ORIGIN: origin,
      EPHYRA_SESSION_KEY: Buffer.alloc(32, 17).toString("base64"),
      EPHYRA_APPROVER_DIDS: did,
      NOTORGANIC_PRODUCT: "ephyra",
      NOTORGANIC_ISSUER: "https://api.notorganic.test",
      NOTORGANIC_AUTHORIZATION_URL: `${origin}/fixture/authorize`,
      EPHYRA_CONSOLE_DIR: join(root, "dist"),
    }),
    {
      startJobs: true,
      repository: {
        discover: async (input) => {
          assert.equal(input.url, fixtureUrl);
          return "fixture-default";
        },
        prepare: async (input, directory) => {
          assert.equal(input.url, fixtureUrl);
          assert.equal(input.branch, "fixture-default");
          await mkdir(directory, { recursive: true });
          await fixtureGit(["clone", "--bare", "--quiet", fixtureRepo, join(directory, "workspace.git")], fixtureRepo);
          repositoryConnections++;
          return { url: input.url, branch: input.branch, head: fixtureHead, verifiedAt: new Date().toISOString() };
        },
      },
      notOrganicFetch: provider.fetcher,
      providerFetch: async (url, init) => {
        if (url.endsWith("/models")) return Response.json({ data: [{ id: "fixture-chat" }] });
        const body = JSON.parse(String(init?.body));
        modelCalls.push({ authorization: new Headers(init?.headers).get("authorization"), model: body.model });
        return Response.json({
          model: "fixture-chat-returned",
          choices: [{ message: { content: JSON.stringify({ text: "Fixture reply from the saved provider." }) } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        });
      },
    },
  );
  const server = app;
  http.reload({
    fetch: (request) =>
      new URL(request.url).pathname === "/fixture/authorize"
        ? Response.redirect(provider.approve(request.url), 302)
        : server.app.fetch(request),
  });
  site.reload({ fetch: createSite({ origin: site.url.origin, root: join(root, "../../site"), apiOrigin: origin }) });
  browser = await launch();

  for (const width of [1440, 390]) {
    account.did = did;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    // Catalog metadata is a named offline fixture; no browser test contacts public model providers.
    await page.route("https://models.dev/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          openai: {
            id: "openai",
            name: "OpenAI",
            npm: "@ai-sdk/openai",
            models: { "fixture-chat": { id: "fixture-chat", name: "Fixture chat" } },
          },
        }),
      }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(site.url.href);
    const open = page.getByRole("navigation", { name: "Site", exact: true }).getByRole("link", { name: "Open app" });
    assert.ok(await open.isVisible(), "app entry remains visible on mobile");
    await open.click();
    await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, origin);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(artifacts, `signin-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).click();
    if (width === 1440) {
      await page.getByRole("heading", { name: "Let Ephyra set up your application", exact: true }).waitFor();
      await page.getByRole("button", { name: "Connect knowledge", exact: true }).click();
      await page.getByRole("link", { name: "Continue with Not Organic", exact: true }).click();
      await page.getByRole("checkbox", { name: "Read shared resources", exact: true }).waitFor();
      const manage = new URL((await page.getByRole("link", { name: "Manage connections in Not Organic ↗", exact: true }).getAttribute("href"))!);
      assert.equal(manage.searchParams.get("app_client"), origin);
      assert.equal(manage.searchParams.get("return_to"), `${origin}/app/#/onboarding`);
      await page.getByRole("checkbox", { name: "Read shared resources", exact: true }).check();
      await page.getByRole("combobox", { name: "Search tool", exact: true }).selectOption({ label: "search_notes" });
      await page.getByRole("button", { name: "Save connections", exact: true }).click();
      await page.getByText("Knowledge preferences saved.", { exact: true }).waitFor();
      const knowledge = await page.evaluate(async () => (await fetch("/v1/account")).json());
      assert.equal(knowledge.knowledge.sources[0].searchTool.name, "search_notes");
      await page.screenshot({ path: join(artifacts, "knowledge-onboarding.png"), fullPage: true });
      await page.getByRole("textbox", { name: "Repository address", exact: true }).fill(fixtureUrl);
      assert.equal(await page.getByRole("textbox", { name: /^Branch \(optional\)/ }).inputValue(), "");
      await page.getByRole("button", { name: "Connect and set up automatically", exact: true }).click();
      await page.getByRole("heading", { name: "Setup needs a connection", exact: true }).waitFor({ timeout: 12_000 }).catch(async (error) => {
        await page.screenshot({ path: join(artifacts, "automatic-setup-failure.png"), fullPage: true });
        console.error("Offline setup feedback:", await page.locator(".account-feedback").allTextContents());
        throw error;
      });
      const setup = await page.evaluate(async () => (await fetch("/v1/setup")).json());
      assert.equal(setup.mode, "autonomous");
      assert.equal(setup.status, "blocked");
      assert.equal(setup.repository.head, fixtureHead);
      assert.equal(setup.repository.branch, "fixture-default");
      assert.ok(setup.artifacts.some((artifact: { path: string }) => artifact.path === "autonomy.md"));
      const verification = setup.artifacts.find((artifact: { path: string }) => artifact.path === "ephyra/verification.json");
      assert.equal(JSON.parse(verification.content).status, "not_run", "discovery never invents executed checks");
      assert.ok(setup.blockers.some((blocker: { id: string }) => blocker.id === "runner"));
      setupId = setup.id;
      await page.getByText("Inspect setup documents (6)", { exact: true }).click();
      await page.screenshot({ path: join(artifacts, "automatic-setup-recorded.png"), fullPage: true });
      await page.getByRole("button", { name: "Open workspace", exact: true }).click();
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      await page.goto(`${origin}/app/#/settings`);
      await page.getByRole("tab", { name: "Model access", exact: true }).click();
      await page.locator('[data-provider="openai"]').click();
      await page.getByRole("combobox", { name: "Model ID", exact: true }).fill("fixture-chat");
      await page.getByRole("combobox", { name: "Model ID", exact: true }).press("Enter");
      await page.getByLabel("API key", { exact: true }).fill("offline-browser-provider-key");
      await page.getByRole("button", { name: "Save model access", exact: true }).click();
      await page.getByLabel("Replace API key", { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, "model-access-saved.png"), fullPage: true });
      await page.goto(`${origin}/app/#/overview`);
    }
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/app/");
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === "ephyra_session");
    assert.ok(session?.httpOnly);
    assert.equal(await page.evaluate(() => document.cookie), "");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ephyra.connection")), null);
    await page.reload();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Find a page or command" }).fill("settings");
    await page.getByRole("combobox", { name: "Find a page or command" }).press("Enter");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    if (width === 390) {
      // Signing out revoked the previous device session. Reauthorize the saved knowledge choice for this new session.
      await page.getByRole("link", { name: "Continue with Not Organic", exact: true }).click();
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      await page.goto(`${origin}/app/#/settings`);
      await page.getByRole("tab", { name: "Connections", exact: true }).click();
    }
    await page.getByRole("checkbox", { name: "Read shared resources", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Read shared resources", exact: true }).isChecked(), true);
    const sourceOption = await page.getByRole("combobox", { name: "Search tool", exact: true }).inputValue();
    assert.equal(JSON.parse(sourceOption)[0], "search_notes");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(artifacts, `knowledge-settings-${width}.png`), fullPage: true });
    await page.getByRole("tab", { name: "Model access" }).click();
    assert.equal(await page.getByLabel("Replace API key", { exact: true }).inputValue(), "");
    await page.screenshot({ path: join(artifacts, `settings-${width}.png`), fullPage: true });
    const apiKeyField = page.getByLabel("Replace API key", { exact: true });
    await apiKeyField.fill("gs?");
    assert.ok(page.url().endsWith("#/settings"), "single-letter shortcuts do not fire in fields");
    await apiKeyField.fill("");
    await apiKeyField.blur();
    await page.keyboard.press("g");
    await page.keyboard.press("u");
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.goto(`${origin}/app/#/usage`);
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.goto(`${origin}/app/#/workspace`);
    await page.getByRole("button", { name: "Edit the map", exact: true }).click();
    await page.waitForURL(/#\/workspace\/.+/);
    const savedSetup = await page.evaluate(async () => (await fetch("/v1/setup")).json());
    assert.equal(savedSetup.id, setupId, "the durable setup run survives browser reload and sign-in");
    const identity = await page.evaluate(async () => (await fetch("/v1/me")).json());
    assert.equal(identity.principal, did);
    const drafts = await page.evaluate(async () => (await fetch("/v1/drafts")).json());
    assert.ok(drafts.some((draft: { createdBy: string }) => draft.createdBy === did));
    const selected = await page.evaluate(async () => (await fetch("/v1/account")).json());
    const reply = await page.evaluate(
      async ({ id, workspaceId }) => {
        const response = await fetch(`/v1/drafts/${id}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "X-Ephyra-Workspace": workspaceId,
          },
          body: JSON.stringify({ text: "Help explain this policy." }),
        });
        return { status: response.status, body: await response.json() };
      },
      { id: drafts[0].id, workspaceId: selected.workspaceId },
    );
    assert.equal(reply.status, 200);
    assert.ok(JSON.stringify(reply.body).includes("Fixture reply from the saved provider."));
    await page.screenshot({ path: join(artifacts, `workspace-${width}.png`), fullPage: true });
    const currentSession = (await context.cookies()).find((cookie) => cookie.name === "ephyra_session");
    assert.ok(currentSession);
    await page.goto(`${origin}/app/#/settings`);
    await page.getByRole("tab", { name: "Account", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).waitFor();
    assert.ok(!(await context.cookies()).some((cookie) => cookie.name === "ephyra_session"));
    const replay = await fetch(`${origin}/v1/me`, { headers: { cookie: `ephyra_session=${currentSession!.value}` } });
    assert.equal(replay.status, 401, "sign-out revokes the saved session server-side");
    assert.deepEqual(errors, [], "no browser runtime errors");
    await context.close();
    console.log(`PASS public entry → PKCE → persisted setup → real console → draft → account sign-out (${width}px)`);
  }

  account.did = "did:plc:reader123";
  const reader = await browser.newContext();
  const page = await reader.newPage();
  await page.goto(`${origin}/app/`);
  await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).click();
  await page.getByRole("heading", { name: "Let Ephyra set up your application", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Connect knowledge", exact: true }).count(), 1);
  assert.equal((await page.evaluate(async () => (await fetch("/v1/account")).json())).knowledge, undefined,
    "a different account cannot inherit knowledge choices");
  await page.getByRole("button", { name: "Explore first", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.goto(`${origin}/app/#/workspace`);
  const edit = page.getByRole("button", { name: "Edit the map", exact: true });
  await edit.waitFor();
  assert.ok(await edit.isEnabled(), "each account can edit its own workspace");
  assert.deepEqual(
    await page.evaluate(async () => (await fetch("/v1/drafts")).json()),
    [],
    "other accounts cannot see these drafts",
  );
  const refusal = await page.evaluate(
    async () =>
      (
        await fetch("/v1/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "autonomy.md" }),
        })
      ).status,
  );
  assert.equal(refusal, 409, "writes require a current workspace binding");
  await reader.close();
  await writeFile(
    join(artifacts, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        transport: "real loopback HTTP",
        account: "fictional Not Organic fixture",
        checks: [
          "public app entry",
          "PKCE browser callback",
          "knowledge permission upgrade through PKCE",
          "exact source and tool selection before repository setup",
          "knowledge choices persisted into first repository and desktop/mobile Settings",
          "HttpOnly session",
          "automatic onboarding with a local repository connector fixture",
          "real setup queue and Git-backed document receipts",
          "readiness blockers without invented execution",
          "saved BYOK model settings",
          "account-settings signout",
          "reload",
          "settings",
          "shortcuts",
          "usage",
          "draft creation",
          "saved provider request",
          "revocation",
          "account isolation",
        ],
        unverified: ["hosted account login", "remote git transport", "live providers", "live MCP connections", "production execution"],
      },
      null,
      2,
    ),
  );
  assert.equal(repositoryConnections, 1);
  assert.ok(knowledgeLists > 0);
  assert.equal(modelCalls.length, 2);
  assert.ok(
    modelCalls.every(
      (call) => call.authorization === "Bearer offline-browser-provider-key" && call.model === "fixture-chat",
    ),
  );
  console.log("PASS account isolation and saved provider requests; artifacts:", artifacts);
} finally {
  await browser?.close();
  http.stop(true);
  site.stop(true);
  await app?.close();
  await rm(dir, { recursive: true, force: true });
}
