// Browser checks for system defaults, live OS changes and explicit theme preferences. No external requests.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const output = join(root, "artifacts/theme");
await mkdir(output, { recursive: true });
const server = serve(join(root, "dist"), "/app/");
const browser = await launch();
const results: object[] = [];
try {
  for (const width of [1440, 390, 320]) {
    for (const system of ["light", "dark"] as const) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        colorScheme: system,
        reducedMotion: "reduce",
      });
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.url ? route.continue() : route.abort(),
      );
      await page.goto(`${server.url}/app/?demo=1#/settings`);
      const control = page.getByRole("switch", { name: "Dark mode", exact: true });
      await control.waitFor();
      assert.equal(await control.getAttribute("aria-checked"), String(system === "dark"));
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), null);
      assert.equal(await page.evaluate(() => localStorage.getItem("ephyra.theme")), null);
      assert.equal(await page.locator(".app-foot").getByRole("switch").count(), 0);
      const switchBox = await control.boundingBox();
      const commandBox = await page.getByRole("button", { name: "Open commands and keyboard shortcuts" }).boundingBox();
      assert.ok(switchBox && commandBox && switchBox.height >= 44 && switchBox.width >= 44);
      assert.ok(switchBox.y < 100 && Math.abs(switchBox.y - commandBox.y) < 3, "theme and Commands share the top row");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "toolbar fits");
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(output, `${system}-${width}.png`), fullPage: true });
      await page.locator(".workspace-bar").screenshot({ path: join(output, `toolbar-${system}-${width}.png`) });
      const initialBackground = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg"),
      );

      const opposite = system === "dark" ? "light" : "dark";
      await page.emulateMedia({ colorScheme: opposite });
      await page.waitForFunction(
        (dark) => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === String(dark),
        opposite === "dark",
      );
      assert.notEqual(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg")),
        initialBackground,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ephyra.theme")),
        null,
        "OS changes do not become manual preferences",
      );

      await control.focus();
      await control.press("Space");
      await page.waitForFunction((value) => localStorage.getItem("ephyra.theme") === value, system);
      assert.equal(await control.getAttribute("aria-checked"), String(system === "dark"));
      await page.emulateMedia({ colorScheme: system });
      await page.emulateMedia({ colorScheme: opposite });
      assert.equal(
        await control.getAttribute("aria-checked"),
        String(system === "dark"),
        "an explicit preference wins over the OS",
      );
      await page.reload();
      await control.waitFor();
      assert.equal(
        await control.getAttribute("aria-checked"),
        String(system === "dark"),
        "manual preference survives reload",
      );
      await control.check();
      assert.equal(await control.getAttribute("aria-checked"), "true");
      await control.uncheck();
      assert.equal(await control.getAttribute("aria-checked"), "false");
      assert.deepEqual(errors, []);
      results.push({ width, system, followsSystem: true, remembersChoice: true, keyboard: true, toolbarFits: true });
      await page.close();
    }
  }
  await writeFile(join(output, "verification.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.stop();
}
