// Local Storybook fixtures only. Checks rendered entrance/setup/team states, not hosted integrations.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/experience");
mkdirSync(out, { recursive: true });
const site = serve(join(root, "storybook-static"));
const browser = await launch();
const checks: unknown[] = [];
const only = Bun.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const states = [
  ["signin", "components-connectgate--default"],
  ["onboarding", "screens-onboardingpage--initial"],
  ["setup-blocked", "screens-onboardingpage--needs-connection"],
  ["runs", "screens-runspage--default"],
  ["team", "account-team--team"],
  ["invitation", "account-accept-invitation--viewer"],
].filter(([name]) => !only || name === only);
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [name, id] of states) {
        await page.goto(`${site.url}/iframe.html?id=${id}&viewMode=story&globals=theme:${scheme}`);
        await page.locator(".sb-frame h1").waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.locator("img:not([loading=lazy])").evaluateAll(async (images) => {
          await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
        });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: page fits ${width}`);
        const clipped = await page.locator("h1, h2, input, select, button").evaluateAll((elements) => elements.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.right > innerWidth + 1 || r.left < -1);
        }).map((el) => el.tagName + " " + (el.getAttribute("aria-label") ?? el.textContent)));
        assert.deepEqual(clipped, [], `${name} ${width}: controls remain on screen`);
        const broken = await page.locator("img").evaluateAll((elements) => elements.filter((el) => el.complete && !el.naturalWidth).map((el) => el.src));
        assert.deepEqual(broken, [], "art assets load locally");
        if (width !== 320) await page.screenshot({ path: join(out, `${name}-${width}-${scheme}.png`), fullPage: true });
        checks.push({ name, scheme, width, result: "pass" });
      }
    }
    assert.deepEqual(errors, [], "no browser runtime errors");
    await context.close();
  }
  writeFileSync(join(out, only ? `layout-checks-${only}.json` : "layout-checks.json"), JSON.stringify(checks, null, 2));
  console.log(`PASS ${checks.length} entrance, setup, activity and team fixture layouts`);
} finally { await browser.close(); site.stop(); }
