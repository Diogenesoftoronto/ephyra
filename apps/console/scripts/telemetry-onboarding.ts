// Real local Chromium interactions; every account operation uses explicit fictional demo data.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/telemetry-onboarding");
await mkdir(out, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const browser = await launch();
try {
  for (const [width, colorScheme] of [[1280, "light"], [390, "light"], [390, "dark"]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${app.url}/app/?demo=1#/onboarding`);
    await page.getByRole("heading", { name: "Connect application signals" }).waitFor();
    await page.getByLabel("Repository address", { exact: true }).fill("https://git.example.org/fictional/mobile.git");
    await page.getByLabel("Branch (optional)", { exact: true }).fill("main");
    await page.getByRole("button", { name: "Connect and set up automatically", exact: true }).click();
    await page.getByRole("heading", { name: "Your application’s setup", exact: true }).waitFor();
    const sentry = page.getByRole("button", { name: /Sentry Application errors/ });
    await sentry.focus();
    await page.keyboard.press("Enter");
    const form = page.getByRole("form", { name: "Sentry connection", exact: true });
    await form.getByLabel("Organization / project", { exact: true }).fill("fictional-team/mobile");
    await form.getByLabel("Sentry API token", { exact: true }).fill("fixture-secret-never-live");
    await form.getByRole("button", { name: "Check access and save" }).click();
    await form.getByText("Fictional fixture. No provider was contacted or verified.", { exact: true }).waitFor();
    assert.equal(await form.locator('input[type="password"]').inputValue(), "");
    assert.equal(await page.getByText("Access checked", { exact: true }).count(), 0);
    // A changed source must never silently reuse credentials bound to another source.
    await form.getByLabel("Organization / project", { exact: true }).fill("fictional-team/other");
    assert.equal(await form.getByLabel("Sentry API token", { exact: true }).getAttribute("required"), "");
    await page.getByRole("button", { name: /Firebase Crashlytics/ }).click();
    const mobile = page.getByRole("form", { name: "Firebase Crashlytics connection", exact: true });
    await mobile.getByLabel("Service account JSON", { exact: true }).waitFor();
    await mobile.getByLabel("Google authentication", { exact: true }).selectOption("token");
    await mobile.getByLabel("Google OAuth access token", { exact: true }).waitFor();
    await page.getByRole("button", { name: /Datadog Service logs/ }).click();
    await page.getByRole("form", { name: "Datadog connection", exact: true }).getByLabel("Application key", { exact: true }).waitFor();
    await page.getByRole("button", { name: /Grafana Loki/ }).click();
    await page.getByRole("form", { name: "Grafana Loki connection", exact: true }).getByLabel("Basic auth username (optional)", { exact: true }).waitFor();
    await page.locator(".telemetry-collector summary").click();
    await page.getByRole("button", { name: "Get collector settings", exact: true }).click();
    const collectorToken = page.getByLabel("Collector token", { exact: true });
    await collectorToken.waitFor();
    assert.equal(await collectorToken.getAttribute("type"), "password");
    assert.equal(await page.getByLabel("Traces endpoint", { exact: true }).inputValue(), "https://telemetry.example.org/v1/traces");
    await page.getByLabel("Show collector token", { exact: true }).check();
    assert.equal(await collectorToken.getAttribute("type"), "text");
    await page.getByLabel("Show collector token", { exact: true }).uncheck();
    await page.locator(".telemetry-collector summary").click();
    const loaded = await page.locator(".telemetry-logo").evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
    assert.ok(loaded, "all bundled provider logos render");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "viewport overflow");
    await page.locator(".telemetry-sources").screenshot({ path: join(out, `sources-${width}-${colorScheme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS telemetry onboarding ${width}px: keyboard, credentials, fixture save, provider switching, logo loads, no overflow`);
  }
} finally { await browser.close(); app.stop(); }
