// Local fixtures only. Preview tools cannot emulate reduced motion or a coarse touch pointer.
// Build console and Storybook first, then run with: env -u LD_LIBRARY_PATH bun scripts/velum-motion.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/velum-motion");
await mkdir(out, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const stories = serve(join(root, "storybook-static"));
const browser = await launch();
const evidence: unknown[] = [];
try {
  for (const width of [320, 390]) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        reducedMotion,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto(`${stories.url}/iframe.html?id=usage-forecast--pending&viewMode=story`);
      await page.getByRole("button", { name: "Forecast spend", exact: true }).click();
      const dot = page.locator(".forecast__dot");
      await dot.waitFor();
      const animation = await dot.evaluate((el) => getComputedStyle(el).animationName);
      assert.equal(animation, reducedMotion === "reduce" ? "none" : "forecast-wait");
      await page.getByRole("button", { name: "Stop waiting", exact: true }).click();
      await page.getByRole("button", { name: "Check saved forecast", exact: true }).waitFor();
      await page.goto(`${app.url}/app/?demo=1#/workspace`);
      await page
        .getByRole("button", { name: /Ask Velum/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Refer to something", exact: true }).click();
      const region = page.locator('[data-velum-source="area:payments"]');
      await region.tap();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("list", { name: "Referenced in your next message" }).waitFor();
      const dimensions = await page.evaluate(() => {
        const panel = document.querySelector("#velum-companion")!;
        const composer = panel.querySelector(".velum-composer")!;
        const conversation = panel.querySelector(".velum-viewport")!;
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panel: panel.getBoundingClientRect().toJSON(),
          composer: composer.getBoundingClientRect().toJSON(),
          conversation: conversation.getBoundingClientRect().toJSON(),
          targets: [...panel.querySelectorAll<HTMLButtonElement>(".velum-chip button,.velum-composer-row button")].map(
            (b) => ({ label: b.textContent?.trim(), height: b.getBoundingClientRect().height }),
          ),
        };
      });
      assert.equal(dimensions.coarse, true);
      assert.equal(dimensions.reduced, reducedMotion === "reduce");
      assert.equal(dimensions.overflow, 0);
      assert.ok(dimensions.composer.bottom <= dimensions.panel.bottom + 1, "composer fits within the phone sheet");
      assert.ok(dimensions.conversation.height >= 80, "conversation remains visible above the composer");
      for (const target of dimensions.targets) assert.ok(target.height >= 44, `${target.label} has a touch target`);
      await page.screenshot({ path: join(out, `${width}-${reducedMotion}.png`), fullPage: false });
      evidence.push({ width, reducedMotion, forecastAnimation: animation, ...dimensions });
      await context.close();
    }
  }
  await writeFile(join(out, "verified.json"), JSON.stringify({ fixturesOnly: true, evidence }, null, 2));
  console.log(
    "Touch selection, composer layout, 44px controls and reduced-motion forecast states passed (4 contexts).",
  );
} finally {
  await browser.close();
  app.stop();
  stories.stop();
}
