// Local browser fixture contract: real built console, intercepted account/setup HTTP only.
// No repository, provider, forge or hosted account request is made.
// Build first, then: env -u LD_LIBRARY_PATH bun apps/console/scripts/automatic-setup.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SetupMode, SetupRun } from "@ephyra/core";
import { ACCOUNT_FIXTURE, CONNECTED_ACCOUNT_FIXTURE } from "../src/fake/account.ts";
import { SETUP_FIXTURE } from "../src/fake/setup.ts";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/automatic-setup");
await mkdir(artifacts, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const browser = await launch();
const completed: string[] = [];
const scenarios = [
  { name: "autonomous-desktop", width: 1440, mode: "autonomous" as SetupMode, loseResponse: false },
  { name: "supervised-phone", width: 390, mode: "supervised" as SetupMode, loseResponse: false },
  { name: "interrupted-reload", width: 1440, mode: "autonomous" as SetupMode, loseResponse: true },
];

try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: 950 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let account = structuredClone(ACCOUNT_FIXTURE);
    let run: SetupRun | null = null;
    let starts = 0;
    let repositorySaves = 0;
    let progressReads = 0;
    let releaseReceipt = !scenario.loseResponse;
    let exactReceiptReads = 0;
    let recordedKey: string | null = null;
    const identity = { principal: account.did, alias: "fixture-operator", kind: "human", approver: true };
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== app.url) {
        unexpected.push(`external request: ${url.origin}${url.pathname}`);
        return route.abort();
      }
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
      if (url.pathname === "/auth/session") return json({ signIn: true, identity });
      if (url.pathname === "/v1/me") return json(identity);
      if (url.pathname === "/v1/account") return json(account);
      if (url.pathname === "/v1/account/workspaces") return json([
        { workspaceId: account.workspaceId, ownerDid: account.did, name: "Offline fixture", role: "owner" },
      ]);
      if (url.pathname === "/v1/inbox") return json([]);
      if (url.pathname === "/v1/account/repository") {
        repositorySaves++;
        const body = request.postDataJSON();
        assert.equal(body.discoverDefaultBranch, true, "blank branch requests remote default discovery");
        assert.equal(body.url, "https://github.com/fixture/application.git");
        assert.equal(request.headers()["x-ephyra-account"], account.did);
        assert.ok(request.headers()["idempotency-key"]);
        account = {
          ...account, version: account.version + 1, workspaceId: "fixture-connected-workspace",
          repository: { ...CONNECTED_ACCOUNT_FIXTURE.repository!, url: body.url, branch: "release/default" },
          onboarding: { status: "in_progress", updatedAt: "2026-11-08T12:00:00.000Z" },
        };
        return json(account);
      }
      if (url.pathname === "/v1/setup") {
        assert.equal(request.headers()["x-ephyra-workspace"], account.workspaceId);
        assert.equal(request.headers()["x-ephyra-principal"], account.did);
        if (request.method() === "POST") {
          starts++;
          assert.equal(request.postDataJSON().mode, scenario.mode);
          recordedKey = request.headers()["idempotency-key"]!;
          assert.ok(recordedKey);
          run = {
            ...structuredClone(SETUP_FIXTURE), id: "fixture-browser-setup", operationKey: recordedKey,
            mode: scenario.mode, status: "queued", repository: account.repository!,
            steps: SETUP_FIXTURE.steps.map((step) => ({ ...step, status: "pending", detail: "Fixture: waiting to run." })),
            blockers: [], artifacts: [],
          };
          if (scenario.loseResponse) return route.abort("connectionreset");
          return json(run);
        }
        const key = url.searchParams.get("operationKey");
        if (key) {
          exactReceiptReads++;
          assert.equal(key, recordedKey, "reload reconciles only the operation it started");
          if (!releaseReceipt) return json(null);
        }
        if (!run) return json(null);
        progressReads++;
        run = progressReads === 1 && !scenario.loseResponse ? {
          ...run, status: "running", steps: [
            { id: "inspect", name: "Inspect repository", status: "complete", detail: "Fixture: package metadata read." },
            { id: "documents", name: "Prepare autonomy documents", status: "running", detail: "Fixture: preparing policy." },
          ],
        } : {
          ...run, status: "blocked", steps: structuredClone(SETUP_FIXTURE.steps), blockers: structuredClone(SETUP_FIXTURE.blockers),
          artifacts: [{
            path: "autonomy.md", digest: "fixture-observed-digest",
            content: '<script>globalThis.__setupExecuted = true</script>\n# Fixture autonomy document',
          }],
        };
        return json(run);
      }
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/auth/")) {
        unexpected.push(`unexpected API request: ${request.method()} ${url.pathname}`);
        return json({ error: "Offline fixture has no such route" }, 404);
      }
      return route.continue();
    });
    try {
      await page.goto(`${app.url}/app/#/onboarding`);
      await page.getByRole("heading", { name: "Let Ephyra set up your application", exact: true }).waitFor();
      assert.ok(await page.getByRole("radio", { name: /^Self-driving/ }).isChecked(), "autonomy is the initial default");
      if (scenario.mode === "supervised") await page.getByRole("radio", { name: /^Supervised/ }).check();
      const branch = page.getByRole("textbox", { name: /^Branch \(optional\)/ });
      assert.equal(await branch.inputValue(), "");
      await page.getByRole("textbox", { name: "Repository clone URL", exact: true }).fill("https://github.com/fixture/application.git");
      await page.getByRole("button", { name: "Connect and set up automatically", exact: true }).click();
      if (scenario.loseResponse) {
        await page.getByText("Checking whether setup started", { exact: true }).waitFor();
        assert.equal(starts, 1);
        const pending = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ephyra.setup.pending:")));
        assert.equal(pending.length, 1, "operation reference survives reload");
        releaseReceipt = true;
        await page.reload();
      } else {
        await page.getByRole("heading", { name: "Setting up your application", exact: true }).waitFor();
      }
      await page.getByRole("heading", { name: "Setup needs a connection", exact: true }).waitFor();
      assert.equal(starts, 1, "connecting starts one setup request without a separate Review action");
      assert.equal(repositorySaves, 1);
      await page.getByText("Fixture: connect an isolated runner", { exact: true }).waitFor();
      await page.getByText("For the deployment operator", { exact: true }).waitFor();
      await page.getByText("Inspect setup documents (1)", { exact: true }).click();
      await page.locator(".setup-artifacts details summary").click();
      assert.ok((await page.locator(".setup-artifacts pre").innerText()).includes("<script>"));
      assert.equal(await page.locator(".setup-artifacts script").count(), 0);
      assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { __setupExecuted?: boolean }).__setupExecuted), undefined);
      await page.getByText("fixture-observed-digest", { exact: true }).waitFor();
      assert.ok(await page.getByRole("link", { name: "Inspect agent runs", exact: true }).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
      await page.screenshot({ path: join(artifacts, `${scenario.name}.png`), fullPage: true });
      await page.reload();
      await page.getByRole("heading", { name: "Setup needs a connection", exact: true }).waitFor();
      assert.equal(starts, 1, "a saved run is read after reload, never started again");
      if (scenario.loseResponse) assert.ok(exactReceiptReads > 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      completed.push(scenario.name);
      console.log(`PASS ${scenario.name}: discovery, one start, persisted progress, blockers, escaped artifacts, reload`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${scenario.name}-failure.png`), fullPage: true });
      throw error;
    } finally {
      await context.close();
    }
  }
  await writeFile(join(artifacts, "verification.json"), JSON.stringify({
    passed: true, transport: "built console with offline HTTP fixtures", cases: completed,
    unverified: ["hosted sign-in", "real git clone", "live model execution", "forge landing", "Traction production"],
  }, null, 2));
  console.log(`PASS ${completed.length} browser scenarios; artifacts: ${artifacts}`);
} finally {
  await browser.close();
  app.stop();
}
