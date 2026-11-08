// Local verification of the separately built Not Organic entrance. Session lookup is an offline 401 fixture.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
const build = Bun.argv[2];
if (!build) throw new Error("Pass the absolute path to the Not Organic dist/portal build.");
const site = serve(build);
const browser = await launch();
const out = join(import.meta.dir, "../artifacts/juice"); mkdirSync(out, { recursive: true });
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthorized", message: "Offline signed-out fixture" } }) }));
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page.goto(`${site.url}/?product=ephyra&theme=${scheme}&action=signin`);
      await page.locator(".entrance-arrival").getByText("Ephyra", { exact: true }).waitFor();
      await page.locator("input[autocomplete=username]").waitFor();
      await page.locator(".ephyra-arrival-art img").evaluate((img: HTMLImageElement) => img.decode());
      assert.equal(await page.locator("html").getAttribute("data-product"), "ephyra");
      assert.ok(await page.locator(".entrance-intro").innerText().then(text => text.includes("Ephyra")));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator("input[autocomplete=username]").focus();
      assert.notEqual(await page.locator(".handle-field").evaluate(field => getComputedStyle(field).outlineStyle), "none");
      if (width !== 320) await page.screenshot({ path: join(out, `notorganic-ephyra-${width}-${scheme}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS Ephyra identity, account field, keyboard focus, 320/390/1440px reflow in light and dark Not Organic sign-in");
} finally { await browser.close(); site.stop(); }
