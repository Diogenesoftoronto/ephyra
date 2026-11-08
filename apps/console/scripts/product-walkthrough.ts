// Offline browser check: the landing frame renders production React screens with fictional adapters.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSite } from "../../web/src/site.ts";
import { launch } from "./browser.ts";
const root = resolve(import.meta.dir, "../../..");
const out = join(root, "apps/console/artifacts/juice"); mkdirSync(out, { recursive: true });
let handler: (request: Request) => Promise<Response>;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  const prefix = path.startsWith("/e/app/") ? "/e/app/" : path.startsWith("/app/") && path !== "/app/" ? "/app/" : null;
  if (prefix) {
    const directory = join(root, prefix === "/e/app/" ? "apps/console/dist-walkthrough" : "apps/console/public");
    const file = Bun.file(join(directory, path.slice(prefix.length)));
    return await file.exists() ? new Response(file) : new Response("Missing asset", { status: 404 });
  }
  return handler(request);
} });
const origin = `http://127.0.0.1:${server.port}`;
handler = createSite({ root: join(root, "site"), origin, apiOrigin: "https://console.example.test" });
const browser = await launch();
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage(); const errors: string[] = []; const missing: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.url().startsWith(origin) && response.status() >= 400) missing.push(response.url()); });
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const showcase = page.locator("[data-product-tour]"); await showcase.scrollIntoViewIfNeeded();
    const app = showcase.frameLocator("iframe");
    for (const scene of ["overview", "onboarding", "runs", "workspace", "personas", "team"]) {
      await showcase.locator(`[data-product-scene="${scene}"]`).click();
      await app.locator(`[data-tour-scene="${scene}"]`).waitFor();
      await app.getByRole("heading", { level: 1 }).first().waitFor();
      const dimensions = await app.locator("body").evaluate(node => ({ width: node.scrollWidth, view: innerWidth }));
      if (dimensions.width > dimensions.view + 1) {
        await showcase.screenshot({ path: join(out, `product-tour-overflow-${width}.png`) });
        console.log(await app.locator("body").evaluate(() => [...document.querySelectorAll("body *")].filter(node =>
          node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ tag: node.tagName, cls: node.className,
          width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })).slice(0, 12)));
      }
      assert.ok(dimensions.width <= dimensions.view + 1, `${scene} fits ${width}px`);
      if (scene === "overview" || scene === "onboarding") await showcase.screenshot({ path: join(out, `product-tour-${scene}-${width}.png`) });
    }
    await page.locator("#how").scrollIntoViewIfNeeded();
    const trail = page.frameLocator("#gui-panel iframe");
    await trail.locator(".trail-panel").waitFor();
    // Explicit step navigation remains available even when scroll-driven scenes use reduced motion.
    for (let i = 0; i < 8 && !await page.locator(".term-prev").isDisabled(); i++) await page.locator(".term-prev").click();
    for (const scene of ["triaged", "hypothesis", "explain", "revise", "plan", "proof", "watching", "set", "rollback"]) {
      await trail.locator(`[data-tour-scene="${scene}"]`).waitFor();
      if (scene === "proof") {
        await trail.getByText("Recorded proof", { exact: true }).waitFor();
        await trail.getByText("tests: 412 passed, 0 failed, 0 new failures", { exact: true }).waitFor();
        await page.locator(".term").screenshot({ path: join(out, `product-tour-proof-${width}.png`) });
      }
      if (scene !== "rollback") await page.locator(".term-next").click();
    }
    // A message from a foreign origin cannot replace the displayed scene.
    await trail.locator("body").evaluate(() => dispatchEvent(new MessageEvent("message", {
      origin: "https://other.example", source: parent, data: { type: "ephyra:tour", scene: "team" },
    })));
    assert.equal(await trail.locator('[data-tour-scene="rollback"]').count(), 1);
    assert.deepEqual(errors, []); assert.deepEqual(missing, []);
    await context.close();
    console.log(`PASS actual app screens, nine recorded trail scenes, frame boundary and layout at ${width}px`);
  }
} finally { await browser.close(); server.stop(true); }
