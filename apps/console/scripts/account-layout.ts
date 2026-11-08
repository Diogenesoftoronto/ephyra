// Offline browser checks for section navigation, retained inputs and responsive account layouts.
// Build Storybook first; run with env -u LD_LIBRARY_PATH bun apps/console/scripts/account-layout.ts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/account-layout");
await mkdir(artifacts, { recursive: true });
const server = serve(join(root, "storybook-static"));
const browser = await launch();
const report: object[] = [];
try {
  for (const width of [1440, 1024, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === server.url) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const story = async (id: string) => {
      await page.goto(`${server.url}/iframe.html?id=${id}&viewMode=story`);
      await page.locator(".account-page").waitFor();
      await page.evaluate(() => document.fonts.ready);
    };
    const capture = async (name: string) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no overflow`);
      await page.screenshot({ path: join(artifacts, `${name}-${width}.png`), fullPage: true });
    };

    await story("screens-settingspage--connected");
    const urlBox = await page.getByLabel("Repository address").boundingBox();
    const branchBox = await page.getByLabel("Branch", { exact: true }).boundingBox();
    assert.ok(urlBox && branchBox);
    assert.ok(Math.abs(urlBox.height - branchBox.height) < 1, "repository fields keep the same control height");
    await capture("repository");
    const repository = page.getByRole("tab", { name: /^Repository/ });
    const models = page.getByRole("tab", { name: /^Model access/ });
    const account = page.getByRole("tab", { name: /^Account/ });
    assert.equal(await page.getByRole("tabpanel").count(), 1, "only the current panel is exposed");
    await page.getByLabel("Branch", { exact: true }).fill("layout-draft");
    await models.click();
    await page.locator('[data-provider="openai"] input').check();
    await page.getByRole("combobox", { name: "Model ID", exact: true }).fill("layout-fixture-model");
    await page.getByRole("combobox", { name: "Model ID", exact: true }).press("Enter");
    await page.getByLabel("API key", { exact: true }).fill("fixture-only-unsaved-key");
    await page.getByRole("combobox", { name: "Model ID", exact: true }).focus();
    await page.getByRole("listbox").waitFor({ state: "attached" });
    assert.equal(await page.locator(".model-picker-popup").isVisible(), true);
    await account.click();
    assert.equal(await page.getByRole("listbox").count(), 0, "a model popup cannot outlive its visible section");
    await capture("account");
    await models.click();
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "fixture-only-unsaved-key");
    assert.equal(
      await page.getByRole("combobox", { name: "Model ID", exact: true }).inputValue(),
      "layout-fixture-model",
    );
    assert.equal(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("fixture-only-unsaved-key")),
      false,
    );
    await page.getByLabel("API key", { exact: true }).fill("");
    await page.getByText("Advanced connection settings", { exact: true }).click();
    await page.getByRole("button", { name: "Use a custom endpoint" }).click();
    await page.getByLabel("API base URL", { exact: true }).fill("https://fixture.example.org/v1");
    await capture("model-access");
    await repository.click();
    assert.equal(await page.getByLabel("Branch", { exact: true }).inputValue(), "layout-draft");
    await repository.press("ArrowRight");
    assert.equal(await models.getAttribute("aria-selected"), "true");
    await models.press("End");
    assert.equal(await account.getAttribute("aria-selected"), "true");
    await account.press("Home");
    assert.equal(await repository.getAttribute("aria-selected"), "true");

    await story("screens-onboardingpage--initial");
    await capture("onboarding");
    await page.getByRole("button", { name: "Skip repository" }).click();
    assert.equal(
      await page.getByRole("heading", { name: "Choose model access" }).evaluate((el) => el === document.activeElement),
      true,
    );
    await page.locator('[data-provider="openai"] input').check();
    await capture("onboarding-models");
    await page.locator('[data-provider="none"] input').check();
    await page.getByRole("button", { name: "Continue without a model" }).click();
    await page.getByRole("heading", { name: "Review your setup" }).waitFor();
    await capture("onboarding-review");
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.getByRole("status").filter({ hasText: "Fixture: workspace opened. Setup is skipped." }).waitFor();

    if (width === 1440 || width === 390) {
      await story("screens-settingspage--dark-model-access");
      await capture("settings-dark");
      await story("screens-settingspage--uncertain-save");
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByRole("button", { name: "Save repository" }).isDisabled(), true);
      await page.getByRole("button", { name: "Refresh saved settings" }).click();
      await page.getByRole("button", { name: "Save repository" }).waitFor({ state: "visible" });
      assert.equal(await page.getByRole("button", { name: "Save repository" }).isEnabled(), true);
    }
    assert.deepEqual(external, [], "stories do not contact a provider or catalog");
    assert.deepEqual(errors, [], "no browser exceptions");
    report.push({
      width,
      inputsRetained: true,
      keyboardNavigation: true,
      optionalSetup: true,
      overflow: false,
      externalRequests: 0,
    });
    await page.close();
  }
  await writeFile(join(artifacts, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.stop();
}
