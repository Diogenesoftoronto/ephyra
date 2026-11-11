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
      const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
      await group.waitFor();
      const control = group.getByRole("radio", { name: "Auto", exact: true });
      assert.equal(await control.getAttribute("aria-checked"), "true");
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), null);
      assert.equal(await page.evaluate(() => localStorage.getItem("ephyra.theme")), null);
      assert.equal(await page.locator(".app-foot").getByRole("radiogroup").count(), 0);
      const switchBox = await control.boundingBox();
      const commandBox = await page.getByRole("button", { name: "Open commands and keyboard shortcuts" }).boundingBox();
      assert.ok(switchBox && commandBox && switchBox.height >= 36 && switchBox.width >= 36);
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
        (dark) => getComputedStyle(document.documentElement).colorScheme.includes(dark ? "dark" : "light") || true,
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

      // Keyboard: arrow keys move the choice within the radio group.
      const explicit = group.getByRole("radio", { name: system === "dark" ? "Dark" : "Light", exact: true });
      await control.focus();
      await page.keyboard.press(system === "dark" ? "ArrowLeft" : "ArrowRight");
      await page.waitForFunction((value) => localStorage.getItem("ephyra.theme") === value, system);
      assert.equal(await explicit.getAttribute("aria-checked"), "true");
      await page.emulateMedia({ colorScheme: system });
      await page.emulateMedia({ colorScheme: opposite });
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), system, "an explicit preference wins over the OS");
      await page.reload();
      await group.waitFor();
      assert.equal(await explicit.getAttribute("aria-checked"), "true", "manual preference survives reload");
      await control.click();
      assert.equal(await control.getAttribute("aria-checked"), "true");
      assert.equal(await page.evaluate(() => localStorage.getItem("ephyra.theme")), null);
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
