// Offline browser regression: real server, PKCE callback, protected cookies and policy-draft writes.
// Only Not Organic is a named fixture. This does not prove a hosted account or provider integration.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { compose, type Composed } from "../../server/src/compose.ts";
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
let app: Composed | undefined;
let browser: Browser | undefined;
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });
const origin = http.url.origin;
const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });

try {
  await mkdir(artifacts, { recursive: true });
  app = await compose(readConfig({
    EPHYRA_API_TOKEN: "offline-browser-service-token", EPHYRA_DATA_DIR: dir,
    EPHYRA_PUBLIC_ORIGIN: origin, EPHYRA_SESSION_KEY: Buffer.alloc(32, 17).toString("base64"),
    EPHYRA_APPROVER_DIDS: did, NOTORGANIC_PRODUCT: "ephyra", NOTORGANIC_ISSUER: "https://api.notorganic.test",
    NOTORGANIC_AUTHORIZATION_URL: `${origin}/fixture/authorize`, EPHYRA_CONSOLE_DIR: join(root, "dist"),
  }), { startJobs: false, notOrganicFetch: provider.fetcher });
  const server = app;
  http.reload({ fetch: (request) => new URL(request.url).pathname === "/fixture/authorize"
    ? Response.redirect(provider.approve(request.url), 302) : server.app.fetch(request) });
  site.reload({ fetch: createSite({ origin: site.url.origin, root: join(root, "../../site"), apiOrigin: origin }) });
  browser = await launch();

  for (const width of [1440, 390]) {
    account.did = did;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
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
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/app/");
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === "ephyra_session");
    assert.ok(session?.httpOnly);
    assert.equal(await page.evaluate(() => document.cookie), "");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ephyra.connection")), null);
    await page.reload();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.goto(`${origin}/app/#/usage`);
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.goto(`${origin}/app/#/workspace`);
    await page.getByRole("button", { name: "Edit the map", exact: true }).click();
    await page.waitForURL(/#\/workspace\/.+/);
    const identity = await page.evaluate(async () => (await fetch("/v1/me")).json());
    assert.equal(identity.principal, did);
    const drafts = await page.evaluate(async () => (await fetch("/v1/drafts")).json());
    assert.ok(drafts.some((draft: { createdBy: string }) => draft.createdBy === did));
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
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.goto(`${origin}/app/#/workspace`);
  const edit = page.getByRole("button", { name: "Edit the map", exact: true });
  await edit.waitFor();
  assert.ok(await edit.isDisabled());
  const refusal = await page.evaluate(async () => (await fetch("/v1/drafts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "autonomy.md" }),
  })).status);
  assert.equal(refusal, 403);
  await reader.close();
  await writeFile(join(artifacts, "verification.json"), JSON.stringify({
    passed: true, transport: "real loopback HTTP", account: "fictional Not Organic fixture",
    checks: ["public app entry", "PKCE browser callback", "HttpOnly session", "reload", "usage", "draft creation", "revocation", "reader restrictions"],
    unverified: ["hosted account login", "live providers"],
  }, null, 2));
  console.log("PASS reader restrictions; artifacts:", artifacts);
} finally {
  await browser?.close();
  http.stop(true);
  site.stop(true);
  await app?.close();
  await rm(dir, { recursive: true, force: true });
}
