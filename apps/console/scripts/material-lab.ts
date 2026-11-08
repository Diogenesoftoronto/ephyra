// Self-contained artifact check, opened directly from disk; no gallery server or hosted model calls.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./browser.ts";
const root = join(import.meta.dir, "../artifacts/material-lab");
await mkdir(root, { recursive: true });
const browser = await launch();
const checks: unknown[] = [];
try {
  for (const width of [390, 728]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.request().url().startsWith("file:") ? route.continue() : route.abort());
    await page.goto(pathToFileURL(join(root, "tiles.html")).href);
    assert.equal(await page.locator(".tile").count(), 15);
    assert.equal(await page.locator(".tile[aria-pressed=true]").count(), 1);
    await page.locator("#filter").selectOption("Rho");
    assert.equal(await page.locator(".tile:visible").count(), 2);
    await page.getByRole("button", { name: /Listening pool/ }).click();
    assert.equal(await page.locator("#sampleName").innerText(), "Rho");
    assert.ok((await page.locator("#stage").getAttribute("style"))?.includes("data:image/webp;base64,"));
    await page.locator("#theme").selectOption("dark");
    assert.equal(await page.locator("#stage").getAttribute("data-theme"), "dark");
    await page.locator("#ui").uncheck();
    assert.equal(await page.locator("#sample").isVisible(), false);
    await page.locator("#grid").check();
    assert.equal(await page.locator("#seams").isVisible(), true);
    await page.locator("#size").focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#sizeValue").innerText(), "104px");
    await page.locator("#strength").focus();
    await page.keyboard.press("Home");
    assert.equal(await page.locator("#strengthValue").innerText(), "5%");
    await page.locator("#filter").selectOption("all");
    for (const image of await page.locator("img").all()) {
      await image.evaluate(async (node: HTMLImageElement) => { await node.decode(); });
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    await page.reload();
    await page.screenshot({ path: join(root, `tiles-${width}.png`), fullPage: true });
    checks.push({ width, tiles: 15, selection: true, filter: true, repeat: true, strength: true, themes: true, images: true });
    await page.close();
  }
  for (const width of [390, 728]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.request().url().startsWith("file:") ? route.continue() : route.abort());
    await page.goto(pathToFileURL(join(root, "media.html")).href);
    assert.equal(await page.locator("video").count(), 3);
    assert.ok(await page.locator("video").evaluateAll((nodes) => nodes.every((node) => node.paused && !node.autoplay)));
    await page.locator("video").first().evaluate(async (video) => { await video.play(); });
    await page.waitForFunction(() => document.querySelector("video")!.currentTime > 0.2);
    await page.getByRole("button", { name: "Images · FLUX" }).click();
    assert.ok(await page.locator("video").evaluateAll((nodes) => nodes.every((node) => node.paused)));
    assert.equal(await page.locator("#images img:visible").count(), 2);
    await page.getByRole("button", { name: "In the application" }).click();
    await page.locator("#screen").selectOption("screen-3");
    await page.locator("#screen-3").evaluate(async (image: HTMLImageElement) => { await image.decode(); });
    assert.equal(await page.locator("#screen-3").isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    checks.push({ width, videos: 3, playback: true, pauseOnTabChange: true, imageStudies: 2, applicationViews: true });
    await page.close();
  }
  await writeFile(join(root, "checks.json"), JSON.stringify(checks, null, 2));
  console.log("PASS material galleries: 15 tiles, filters, controls, three playable videos, image studies and app views at two widths");
} finally { await browser.close(); }
