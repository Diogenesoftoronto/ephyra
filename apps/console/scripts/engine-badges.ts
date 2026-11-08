// Local fictional fixtures only; no agent, provider or cloud requests.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/engine-badges");
mkdirSync(out, { recursive: true });
const stories = serve(join(root, "storybook-static"));
const app = serve(join(root, "dist"), "/app/");
const browser = await launch();
const checks: unknown[] = [];
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce", hasTouch: true });
    await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const p = await context.newPage();
    p.setDefaultTimeout(8000);
    const errors: string[] = [];
    p.on("pageerror", (error) => errors.push(error.message));
    for (const width of [320, 390, 1440]) {
      await p.setViewportSize({ width, height: 900 });
      await p.goto(`${stories.url}/iframe.html?id=components-enginebadge--default&viewMode=story&globals=theme:${scheme}`);
      const amp = p.locator('.engine-badge[data-brand="amp"]');
      const codex = p.locator('.engine-badge[data-brand="codex"]');
      await amp.waitFor();
      await p.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
      assert.equal(await p.locator(".engine-badge img").count(), 3);
      await amp.hover();
      const tip = p.getByRole("tooltip");
      await tip.waitFor();
      assert.match(await tip.innerText(), /amp\/smart/);
      assert.match(await tip.innerText(), /Amp orb/);
      assert.match(await tip.innerText(), /orb-7qm2x/);
      await tip.hover();
      await p.waitForTimeout(200);
      assert.ok(await tip.isVisible(), "pointer can move into tooltip");
      await p.mouse.move(width - 10, 800);
      await tip.waitFor({ state: "hidden" });
      await codex.focus();
      await tip.waitFor();
      assert.match(await tip.innerText(), /codex\/gpt-6-codex/);
      assert.match(await tip.innerText(), /Amp runner/, "host does not change the Codex mark");
      assert.equal(await codex.getAttribute("aria-describedby"), await tip.getAttribute("id"));
      await p.keyboard.press("Escape");
      await tip.waitFor({ state: "hidden" });
      assert.ok(await codex.evaluate((element) => element === document.activeElement));
      await p.keyboard.press("Tab");
      await tip.waitFor();
      assert.match(await tip.innerText(), /claude-code\/claude-opus-5-5/);
      await p.keyboard.press("Escape");
      await p.locator('.engine-badge[data-brand="unknown"]').first().tap();
      await tip.waitFor();
      assert.match(await tip.innerText(), /judgement-jev\/jev-1.14/);
      await p.locator('.engine-badge[data-brand="unknown"]').last().tap();
      await p.getByRole("tooltip").getByText("Engine not reported", { exact: true }).waitFor();
      await p.touchscreen.tap(width - 10, 800);
      await tip.waitFor({ state: "hidden" });

      await p.goto(`${stories.url}/iframe.html?id=components-enginebadge--long-identity&viewMode=story&globals=theme:${scheme}`);
      await p.locator(".engine-badge").tap();
      await tip.waitFor();
      const box = await tip.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
      assert.equal(await tip.locator("dd").first().innerText(), `custom/${"unabridged-recorded-model-".repeat(6)}`);
      await p.screenshot({ path: join(out, `tooltip-${width}-${scheme}.png`) });

      await p.goto(`${app.url}/app/?demo=1#/runs`);
      await p.locator(".run-roster__agent").first().waitFor();
      assert.equal(await p.locator("a button, button button, button a").count(), 0, "controls are not nested");
      const count = await p.locator(".run-row").count();
      const filter = p.getByRole("button", { name: "Filter runs by Bell", exact: true });
      await p.locator(".run-roster__agent").filter({ has: filter }).locator(".engine-badge").tap();
      await tip.waitFor();
      assert.equal(await filter.getAttribute("aria-pressed"), "false");
      assert.equal(await p.locator(".run-row").count(), count);
      await filter.click();
      assert.equal(await filter.getAttribute("aria-pressed"), "true");
      assert.ok(await p.locator(".run-row").count() < count);
      await filter.click();
      await p.locator(".run-row .engine-badge").first().tap();
      await tip.waitFor();
      assert.ok(p.url().endsWith("#/runs"), "inspect does not navigate");
      await p.keyboard.press("Escape");
      await p.locator(".run-row__link").first().click();
      await p.getByRole("heading", { name: "Transcript", exact: true }).waitFor();
      await p.locator(".run-header .engine-badge").focus();
      await tip.waitFor();
      await p.screenshot({ path: join(out, `run-${width}-${scheme}.png`), fullPage: true });
      checks.push({ width, scheme, result: "pass", checks: "hover, focus, Escape, touch, exact IDs, bounds, independent controls and navigation" });
    }
    await p.route("**/app/engines/codex.svg", (route) => route.fulfill({ status: 404, body: "not found" }));
    await p.goto(`${stories.url}/iframe.html?id=components-enginebadge--default&viewMode=story&globals=theme:${scheme}`);
    const fallback = p.locator('.engine-badge[data-brand="codex"]');
    await fallback.locator("svg").waitFor();
    await fallback.focus();
    await p.getByRole("tooltip").getByText("codex/gpt-6-codex", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    checks.push({ scheme, result: "pass", checks: "missing artwork retains accessible identity and exact details" });
    await context.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(checks, null, 2));
  console.log(`PASS ${checks.length} engine badge interaction and fallback checks`);
} finally { await browser.close(); stories.stop(); app.stop(); }
