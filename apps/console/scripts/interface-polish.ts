// Fixture-only checks for the Overview and its shared navigation/meter changes.
// Build the console and Storybook, then: env -u LD_LIBRARY_PATH bun scripts/interface-polish.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/interface-polish");
mkdirSync(out, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const stories = serve(join(root, "storybook-static"));
const browser = await launch();
const results: unknown[] = [];
const demo = (p: Page) => p.goto(`${app.url}/app/?demo=1#/overview`);
const story = (p: Page, id: string, scheme: string) => p.goto(`${stories.url}/iframe.html?id=${id}&viewMode=story&globals=theme:${scheme}`);
async function noOverflow(p: Page) {
  const clipped = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".waiting-list h3, .waiting-list .ui-button, .ui-card > header h2, .ui-stat, .activity-meta, .ui-meter .row")]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 1);
    }).map((e) => e.textContent));
  assert.deepEqual(clipped, [], "text and actions fit their containers, not merely a clipped body");
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
}

try {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    await ctx.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const p = await ctx.newPage();
    p.setDefaultTimeout(8000);
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    for (const width of [320, 375, 768, 1280, 1440]) {
      await p.setViewportSize({ width, height: 900 });
      await demo(p);
      await p.locator(".waiting-list li").first().waitFor();
      await p.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await p.evaluate(() => document.fonts.ready);
      await noOverflow(p);
      assert.equal(await p.locator(".waiting-list .ui-button--primary").count(), 1);
      assert.equal(await p.locator(".overview__usage [role=meter]").count(), 6, "three budgets, with spend and tokens");
      for (const meter of await p.getByRole("meter").all()) {
        const label = await meter.getAttribute("aria-labelledby");
        assert.ok(label);
        assert.ok((await p.locator(`[id="${label}"]`).innerText()).length > 0);
      }
      await p.getByText("View daily amounts", { exact: true }).click();
      assert.ok(await p.getByRole("table", { name: "Recorded spend by day", exact: true }).isVisible());
      await noOverflow(p);
      await p.getByText("View daily amounts", { exact: true }).click();
      if (width === 375 || width === 1280) {
        await p.screenshot({ path: join(out, `overview-${width}-${scheme}.png`), fullPage: true });
      }
      results.push({ check: "overview layout, daily amounts, named meters", width, scheme, result: "pass" });
    }
    // Rendered foreground/background pairs, including the risk badge's own fill.
    const contrast = await p.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
      };
      const composite = (fg: number[], bg: number[]) => fg.slice(0, 3).map((v, i) => v * fg[3]! + bg[i]! * (1 - fg[3]!));
      const luminance = (c: number[]) => c.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i]!, 0);
      return [".waiting-list h3", ".waiting-list__identity", ".waiting-list__footer p", ".ui-badge--bad", ".ui-badge--warn", ".activity-meta__engine", ".ui-stat .unknown"].map((selector) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const ancestors: HTMLElement[] = [];
        for (let node: HTMLElement | null = el; node; node = node.parentElement) ancestors.unshift(node);
        let bg = [255, 255, 255];
        for (const node of ancestors) bg = composite(rgba(getComputedStyle(node).backgroundColor), bg);
        const fg = composite(rgba(getComputedStyle(el).color), bg);
        const a = luminance(fg), b = luminance(bg);
        return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    for (const pair of contrast) assert.ok(pair.ratio >= 4.5, `${scheme} ${pair.selector}: ${pair.ratio}`);
    results.push({ check: "rendered text contrast", scheme, pairs: contrast });

    await p.setViewportSize({ width: 375, height: 900 });
    await demo(p);
    await p.reload();
    await p.getByRole("button", { name: "Refresh", exact: true }).waitFor();
    await p.keyboard.press("Tab");
    assert.equal(await p.locator(":focus").innerText(), "Skip to content");
    await p.keyboard.press("Enter");
    assert.equal(await p.locator(":focus").getAttribute("class"), "ui-main");
    const more = p.getByRole("button", { name: "More", exact: true });
    await more.focus();
    await p.keyboard.press("Enter");
    assert.equal(await p.locator(":focus").innerText(), "Workspace");
    await p.keyboard.press("ArrowDown");
    assert.equal(await p.locator(":focus").innerText(), "Personas");
    await p.keyboard.press("End");
    assert.equal(await p.locator(":focus").innerText(), "Settings");
    await p.keyboard.press("ArrowDown");
    assert.equal(await p.locator(":focus").innerText(), "Workspace");
    await p.keyboard.press("Escape");
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    assert.equal(await p.locator(":focus").innerText(), "More");
    await p.keyboard.press("ArrowUp");
    assert.equal(await p.locator(":focus").innerText(), "Settings");
    await p.keyboard.press("Home");
    await p.keyboard.press("Enter");
    await p.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
    assert.equal(await p.locator(":focus").getAttribute("class"), "ui-main");
    assert.equal(await p.title(), "Workspace · Ephyra");
    await more.click();
    await p.keyboard.press("Tab");
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    assert.notEqual(await p.locator(":focus").getAttribute("role"), "menuitem");
    await more.click();
    await p.getByRole("heading", { name: "Workspace", exact: true }).click();
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    results.push({ check: "skip link, More menu keyboard, dismissal, route focus and title", scheme, result: "pass" });

    await p.setViewportSize({ width: 1280, height: 900 });
    await demo(p);
    await p.locator(".waiting-list li").first().waitFor();
    await p.evaluate(() => document.documentElement.style.zoom = "2");
    await noOverflow(p);
    await p.screenshot({ path: join(out, `overview-200-percent-${scheme}.png`), fullPage: true });
    results.push({ check: "200% CSS zoom", scheme, result: "pass" });
    await p.evaluate(() => document.documentElement.style.zoom = "");

    for (const state of ["empty", "loading", "unavailable", "partial-failure"]) {
      await p.setViewportSize({ width: 320, height: 900 });
      await story(p, `screens-overviewpage--${state}`, scheme);
      await p.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      if (state === "empty") await p.getByRole("heading", { name: "Nothing is waiting for you" }).waitFor();
      if (state === "loading") assert.ok(await p.getByRole("button", { name: "Updating…" }).isDisabled());
      if (state === "unavailable") await p.getByRole("button", { name: "Try again" }).first().waitFor();
      if (state === "partial-failure") {
        await p.locator(".waiting-list li").first().waitFor();
        await p.getByRole("button", { name: "Try again" }).waitFor();
      }
      await noOverflow(p);
      await p.screenshot({ path: join(out, `${state}-320-${scheme}.png`), fullPage: true });
      results.push({ check: "Overview state", state, width: 320, scheme, result: "pass" });
    }
    await story(p, "activity-waitinglist--long-titles", scheme);
    await p.locator(".waiting-list li").first().waitFor();
    await noOverflow(p);
    await p.evaluate(() => document.documentElement.dir = "rtl");
    await noOverflow(p);
    results.push({ check: "long titles and RTL at 320px", scheme, result: "pass" });
    assert.deepEqual(errors, [], "no uncaught browser errors");
    await ctx.close();
  }
  writeFileSync(join(out, "checks.json"), JSON.stringify(results, null, 2));
  console.log(`PASS ${results.length} fixture checks. Evidence: ${out}`);
} finally {
  await browser.close(); app.stop(); stories.stop();
}
