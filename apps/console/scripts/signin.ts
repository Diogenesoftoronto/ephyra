// Offline browser regression: real server, PKCE callback, protected cookies and policy-draft writes.
// Only Not Organic is a named fixture. This does not prove a hosted account or provider integration.
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
const account = { approved: true, product: "ephyra", did };
const provider = fakeNotOrganic(account);
const modelCalls: { authorization: string | null; model: string }[] = [];
let app: Composed | undefined;
let browser: Browser | undefined;
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });
const origin = http.url.origin;
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });

try {
  await mkdir(artifacts, { recursive: true });
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
      startJobs: false,
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
      await page.getByRole("heading", { name: "Make this workspace yours", exact: true }).waitFor();
      await page.getByRole("button", { name: "I'll connect a repository later", exact: true }).click();
      await page.locator('[data-provider="openai"]').click();
      await page.getByRole("combobox", { name: "Model ID", exact: true }).fill("fixture-chat");
      await page.getByRole("combobox", { name: "Model ID", exact: true }).press("Enter");
      await page.getByLabel("API key", { exact: true }).fill("offline-browser-provider-key");
      await page.getByRole("button", { name: "Save model access and continue", exact: true }).click();
      await page.getByRole("heading", { name: "Ready to open your workspace", exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, "setup-review.png"), fullPage: true });
      await page.getByRole("button", { name: "Open workspace", exact: true }).click();
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
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).waitFor();
    assert.ok(!(await context.cookies()).some((cookie) => cookie.name === "ephyra_session"));
    const replay = await fetch(`${origin}/v1/me`, { headers: { cookie: `ephyra_session=${session!.value}` } });
    assert.equal(replay.status, 401, "sign-out revokes the saved session server-side");
    assert.deepEqual(errors, [], "no browser runtime errors");
    await context.close();
    console.log(`PASS public entry → PKCE callback → real console → draft → sign-out (${width}px)`);
  }

  account.did = "did:plc:reader123";
  const reader = await browser.newContext();
  const page = await reader.newPage();
  await page.goto(`${origin}/app/`);
  await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).click();
  await page.getByRole("heading", { name: "Make this workspace yours", exact: true }).waitFor();
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
          "HttpOnly session",
          "optional BYOK onboarding",
          "reload",
          "settings",
          "shortcuts",
          "usage",
          "draft creation",
          "saved provider request",
          "revocation",
          "account isolation",
        ],
        unverified: ["hosted account login", "live providers"],
      },
      null,
      2,
    ),
  );
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
