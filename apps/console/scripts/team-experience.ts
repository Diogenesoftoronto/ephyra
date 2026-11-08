// Real local account authority + built console. OAuth identity is an offline fixture; no email/provider calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { composeApplication } from "../../server/src/application.ts";
import { readConfig } from "../../server/src/config.ts";
import { fakeNotOrganic } from "../../server/src/auth/notorganic.fixture.ts";
import { launch } from "./browser.ts";
const root = join(import.meta.dir, "..");
const output = join(root, "artifacts/experience");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "ephyra-team-browser-"));
const ownerDid = "did:plc:offline-team-owner";
const account = { approved: true, product: "ephyra", did: ownerDid };
const issuer = fakeNotOrganic(account);
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("starting", { status: 503 }) });
const origin = http.url.origin;
const app = await composeApplication(readConfig({
  EPHYRA_API_TOKEN: "offline-team-browser-service-token", EPHYRA_DATA_DIR: directory,
  EPHYRA_PUBLIC_ORIGIN: origin, EPHYRA_SESSION_KEY: Buffer.alloc(32, 19).toString("base64"),
  EPHYRA_APPROVER_DIDS: ownerDid, NOTORGANIC_PRODUCT: "ephyra",
  NOTORGANIC_ISSUER: "https://api.notorganic.test", NOTORGANIC_AUTHORIZATION_URL: `${origin}/fixture/authorize`,
  EPHYRA_CONSOLE_DIR: join(root, "dist"),
}), { startJobs: false, notOrganicFetch: issuer.fetcher });
http.reload({ fetch: (request) => new URL(request.url).pathname === "/fixture/authorize"
  ? Response.redirect(issuer.approve(request.url), 302) : app.app.fetch(request) });
const browser = await launch();
const errors: string[] = [];
const checks: string[] = [];
async function tab(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
async function login(page: Page, did: string, url = `${origin}/app/`) {
  account.did = did;
  await page.goto(url);
  await page.getByRole("link", { name: "Sign in with Not Organic", exact: true }).click();
}
try {
  const owner = await tab(1440);
  await login(owner, ownerDid);
  await owner.getByRole("button", { name: "Explore first", exact: true }).click();
  await owner.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const personal = await owner.evaluate(async () => (await fetch("/v1/account")).json());
  for (const [role, width] of [["viewer", 390], ["approver", 1440]] as const) {
    await owner.goto(`${origin}/app/#/team`);
    await owner.reload();
    await owner.getByRole("textbox", { name: "Invitation label", exact: true }).fill(`Offline ${role}`);
    await owner.getByRole("radio", { name: new RegExp(role === "viewer" ? "Viewer" : "Approver") }).check();
    await owner.getByRole("button", { name: "Create invitation link", exact: true }).click();
    const link = await owner.getByRole("textbox", { name: "Invitation link", exact: true }).inputValue();
    const guest = await tab(width);
    await login(guest, `did:plc:offline-${role}`, link);
    await guest.getByRole("button", { name: "Join workspace", exact: true }).waitFor();
    assert.ok(await guest.locator(".invitation-access-note").getByText(role === "viewer" ? "Viewer" : "Approver", { exact: true }).isVisible());
    const before = await guest.evaluate(async () => (await fetch("/v1/account/workspaces")).json());
    assert.equal(before.length, 1, "opening a link and signing in never accepts it");
    await guest.screenshot({ path: join(output, `join-${role}-${width}.png`), fullPage: true });
    await guest.getByRole("button", { name: "Join workspace", exact: true }).click();
    await guest.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(await guest.getByRole("combobox", { name: "Workspace", exact: true }).inputValue(), personal.workspaceId);
    assert.equal(await guest.evaluate(() => sessionStorage.getItem("ephyra.pending-invitation")), null);
    assert.ok(!guest.url().includes("/join/"));
    await guest.reload();
    await guest.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(await guest.getByRole("combobox", { name: "Workspace", exact: true }).inputValue(), personal.workspaceId);
    await guest.goto(`${origin}/app/#/workspace`);
    const edit = guest.getByRole("button", { name: "Edit the map", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isEnabled(), role === "approver", "role governs visible editing actions");
    const status = await guest.evaluate(async (workspaceId) => (await fetch("/v1/drafts", {
      method: "POST", headers: { "content-type": "application/json", "X-Ephyra-Workspace": workspaceId,
        "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ path: "autonomy.md" }),
    })).status, personal.workspaceId);
    assert.equal(status, role === "approver" ? 200 : 403, "server enforces the same role");
    await guest.goto(`${origin}/app/#/runs`);
    await guest.getByRole("heading", { name: "Runs", exact: true }).waitFor();
    await guest.screenshot({ path: join(output, `shared-${role}-${width}.png`), fullPage: true });
    checks.push(`${role}: OAuth handoff, preview, explicit acceptance, shared selection, server and UI authority`);
    await owner.goto(`${origin}/app/#/team`);
    await owner.reload();
    const member = owner.locator("li.team-person").filter({ hasText: `Offline ${role}` });
    await member.getByRole("button", { name: `Remove access for Offline ${role}`, exact: true }).click();
    const dialog = owner.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await owner.locator(":focus").innerText(), "Keep access", "safe initial dialog focus");
    await owner.keyboard.press("Escape");
    assert.equal(await owner.locator(":focus").innerText(), "Remove access", "Escape restores focus");
    await member.getByRole("button", { name: `Remove access for Offline ${role}`, exact: true }).click();
    await dialog.getByRole("button", { name: "Remove access", exact: true }).click();
    await owner.getByText("Access revoked.", { exact: true }).waitFor();
    await guest.evaluate(() => dispatchEvent(new Event("focus")));
    await guest.getByRole("heading", { name: "This workspace is no longer available", exact: true }).waitFor();
    const denied = await guest.evaluate(async (workspaceId) => (await fetch("/v1/runs", {
      headers: { "X-Ephyra-Workspace": workspaceId },
    })).status, personal.workspaceId);
    assert.equal(denied, 409);
    await guest.getByRole("button", { name: "Open my workspace", exact: true }).click();
    await guest.getByRole("button", { name: "Explore first", exact: true }).waitFor();
    checks.push(`${role}: revoke confirmation keyboard, server denial, cached workspace removed, own workspace recovery`);
    await guest.context().close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "team-checks.json"), JSON.stringify({ passed: true, checks,
    boundary: "Real local HTTP and account authority; fake OAuth issuer; no hosted provider, email or deployment." }, null, 2));
  console.log(`PASS ${checks.length} end-to-end team checks (Viewer and Approver, desktop and mobile)`);
} finally { await browser.close(); http.stop(true); await app.close(); await rm(directory, { recursive: true, force: true }); }
