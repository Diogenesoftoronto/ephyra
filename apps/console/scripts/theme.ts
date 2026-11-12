// Fixture-only checks for the two theme icons, shared alignment, card spacing and optional tip toasts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const output = join(root, "artifacts/theme-tips");
await mkdir(output, { recursive: true });
const server = serve(join(root, "dist"), "/app/");
const browser = await launch();
const results: object[] = [];
try {
  for (const width of [1440, 390, 320]) {
    for (const system of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 }, colorScheme: system, reducedMotion: "reduce",
        hasTouch: width < 500, isMobile: width < 500,
      });
      const page = await context.newPage();
      await page.bringToFront();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
      await page.clock.install();
      await page.goto(server.url + "/app/?demo=1#/account");
      await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
      const group = page.locator(width > 480 ? ".workspace-bar .theme-toggle__group" : ".profile-prefs .theme-toggle__group");
      assert.equal(await group.getByRole("radio").count(), 2);
      assert.equal((await group.innerText()).trim(), "", "theme choices use icons without visible text");
      const initial = group.getByRole("radio", { name: system === "dark" ? "Dark" : "Light", exact: true });
      assert.equal(await initial.getAttribute("aria-checked"), "true");
      const opposite = system === "dark" ? "light" : "dark";
      await page.emulateMedia({ colorScheme: opposite });
      await page.waitForFunction((value) =>
        document.querySelector('.profile-prefs [data-choice="' + value + '"]')?.getAttribute("aria-checked") === "true", opposite);
      const selected = group.getByRole("radio", { name: opposite === "dark" ? "Dark" : "Light", exact: true });
      await selected.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((value) => localStorage.getItem("ephyra.theme") === value, system);
      assert.equal(await initial.getAttribute("aria-checked"), "true");
      await page.keyboard.press("Home");
      assert.equal(await group.getByRole("radio", { name: "Light", exact: true }).getAttribute("aria-checked"), "true");
      await page.keyboard.press("End");
      assert.equal(await group.getByRole("radio", { name: "Dark", exact: true }).getAttribute("aria-checked"), "true");
      await page.emulateMedia({ colorScheme: "light" });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "explicit choice wins");
      await page.reload();
      await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
      assert.equal(await group.getByRole("radio", { name: "Dark", exact: true }).getAttribute("aria-checked"), "true", "choice survives reload");
      await group.getByRole("radio", { name: system === "dark" ? "Dark" : "Light", exact: true }).click();
      const sizes = await group.getByRole("radio").evaluateAll(els => els.map(el => {
        const r = el.getBoundingClientRect(); return { width: r.width, height: r.height };
      }));
      assert.ok(sizes.every(r => r.width >= 44 && r.height >= 44), "both icons have 44px targets");
      if (width > 480) {
        const delta = await page.evaluate(() => {
          const t = document.querySelector(".workspace-bar .theme-toggle__group")!.getBoundingClientRect();
          const c = document.querySelector(".command-trigger")!.getBoundingClientRect();
          return Math.abs((t.y + t.height / 2) - (c.y + c.height / 2));
        });
        assert.ok(delta < 1, "theme and Commands share a center line");
      }

      await page.evaluate(() => { location.hash = "#/usage"; });
      await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
      const headingY = await page.locator(".ui-page-header").evaluate(el => el.getBoundingClientRect().y);
      await page.clock.fastForward(1400);
      const tip = page.getByRole("complementary", { name: "Tip", exact: true });
      await tip.waitFor();
      await page.clock.runFor(100);
      assert.equal(await tip.evaluate(el => getComputedStyle(el).position), "fixed");
      assert.equal(await page.locator(".ui-page-header").evaluate(el => el.getBoundingClientRect().y), headingY, "tips never shift the page");
      if (width === 1440 && system === "light") {
        await tip.hover();
        await page.clock.fastForward(13_000);
        assert.equal(await tip.isVisible(), true, "hover pauses dismissal");
        await tip.getByRole("link", { name: "Read more" }).focus();
        await page.mouse.move(1, 1);
        await page.clock.fastForward(13_000);
        assert.equal(await tip.isVisible(), true, "focus pauses dismissal");
      }
      const tipBounds = await tip.boundingBox();
      assert.ok(tipBounds && tipBounds.x >= 0 && tipBounds.x + tipBounds.width <= width, "toast fits");
      await page.screenshot({ path: join(output, "tip-" + system + "-" + width + ".png") });
      await tip.getByRole("button", { name: "Dismiss tip" }).click();
      await page.clock.fastForward(14_000);
      assert.equal(await tip.count(), 0, "dismissal never queues the next tip immediately");
      assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem("ephyra.tips.dismissed") ?? "[]").includes("usage-unknown")));
      await page.evaluate(() => { location.hash = "#/inbox"; });
      await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
      await page.clock.fastForward(1400);
      await tip.waitFor();
      await page.locator(".ui-page-header h1").click();
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => !document.querySelector(".page-tip")?.hasAttribute("data-paused"));
      await page.clock.runFor(100);
      await page.clock.fastForward(13_000);
      await tip.waitFor({ state: "detached" });
      assert.equal(await tip.count(), 0, "unfocused tips expire");
      await page.getByRole("button", { name: "Help", exact: true }).click();
      const help = page.getByRole("dialog", { name: "Inbox", exact: true });
      await help.waitFor();
      assert.ok((await help.innerText()).includes("Read the evidence before the summary"), "dismissed tips stay in Help");
      await help.getByRole("button", { name: "Hide tips", exact: true }).click();
      await page.keyboard.press("Escape");

      for (const route of ["overview", "workspace", "usage"]) {
        await page.evaluate((value) => { location.hash = "#/" + value; }, route);
        await page.locator(".ui-page-header").waitFor();
        await page.waitForFunction((name) => document.title.startsWith(name), route === "workspace" ? "Workspace" : route === "usage" ? "Usage" : "Overview");
        const dimensions = await page.evaluate(() => {
          const repo = document.querySelector(".workspace-bar__repo")!.getBoundingClientRect();
          const setup = document.querySelector(".workspace-setup-note")!.getBoundingClientRect();
          const heading = document.querySelector(".ui-page-header")!.getBoundingClientRect();
          const cards = [...document.querySelectorAll(".ui-card")];
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            toolbarLeft: repo.left, setupLeft: setup.left, headingLeft: heading.left,
            cards: cards.map(el => ({ padding: getComputedStyle(el).padding, quiet: el.classList.contains("ui-card--quiet") && !el.classList.contains("area-card"), right: el.getBoundingClientRect().right })),
          };
        });
        assert.equal(dimensions.overflow, 0, route + " fits the viewport");
        assert.ok(Math.abs(dimensions.toolbarLeft - dimensions.headingLeft) < 1, "workspace and title align");
        assert.ok(Math.abs(dimensions.setupLeft - dimensions.headingLeft) < 1, "setup and title align");
        for (const card of dimensions.cards) {
          assert.ok(parseFloat(card.padding) >= (card.quiet ? 10 : 26), "cards have at least 10px additional padding");
          assert.ok(card.right <= width, "card stays inside the viewport");
        }
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(output, route + "-" + system + "-" + width + ".png") });
        results.push({ width, system, route, ...dimensions });
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }

  // Blocked persistence must not make the selected icon disagree with the applied theme.
  const page = await browser.newPage({ colorScheme: "light" });
  await page.route("**/*", r => new URL(r.request().url()).origin === server.url ? r.continue() : r.abort());
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === "ephyra.theme") throw new Error("blocked"); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === "ephyra.theme") throw new Error("blocked"); return set.call(this, key, value); };
  });
  await page.goto(server.url + "/app/?demo=1#/account");
  const dark = page.locator(".profile-prefs").getByRole("radio", { name: "Dark", exact: true });
  await dark.click();
  assert.equal(await dark.getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await dark.getAttribute("aria-checked"), "true");
  await page.close();

  await writeFile(join(output, "verification.json"), JSON.stringify({ fixturesOnly: true, contexts: 6, blockedStorage: true, results }, null, 2));
  console.log("Theme icons, keyboard and storage, aligned toolbar/setup, 10px card padding and tip recovery passed in six contexts.");
} finally {
  await browser.close();
  server.stop();
}
