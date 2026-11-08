// Explicit ambiguous-write recovery in local Storybook fixtures. No hosted writes or messages.
import assert from "node:assert/strict";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
const server = serve(join(import.meta.dir, "../storybook-static"));
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {
    throw new Error("Offline fixture: clipboard unavailable");
  } } }));
  await page.goto(`${server.url}/iframe.html?id=account-team--uncertain&viewMode=story`);
  await page.getByText("The connection ended before we could confirm this change.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry same operation" }).count(), 0);
  await page.getByRole("button", { name: "Check saved state", exact: true }).click();
  await page.getByRole("button", { name: "Retry same operation", exact: true }).click();
  await page.getByRole("heading", { name: "A place is ready", exact: true }).waitFor();
  assert.equal(await page.locator(".team-list li").filter({ hasText: "Sam · release review" }).count(), 1);
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await page.getByText("Clipboard access is unavailable.", { exact: false }).waitFor();
  assert.equal(await page.locator(":focus").getAttribute("name"), "invitationLink");
  await page.goto(`${server.url}/iframe.html?id=account-accept-invitation--uncertain&viewMode=story`);
  await page.getByRole("button", { name: "Check saved access", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry same operation" }).count(), 0);
  await page.getByRole("button", { name: "Check saved access", exact: true }).click();
  await page.getByRole("button", { name: "Retry same operation", exact: true }).click();
  await page.getByRole("heading", { name: "You’re part of the team", exact: true }).waitFor();
  await page.goto(`${server.url}/iframe.html?id=account-accept-invitation--expired&viewMode=story`);
  await page.getByRole("button", { name: "Check invitation again", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Join workspace", exact: true }).count(), 0);
  await page.goto(`${server.url}/iframe.html?id=account-accept-invitation--revoked-after-opening&viewMode=story`);
  await page.getByRole("button", { name: "Check invitation again", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Join workspace", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS invitation/acceptance recovery, no duplicate invitation, manual clipboard fallback, expired-link guard");
} finally { await browser.close(); server.stop(); }
