// Offline browser proof for the custom-art shader. The default video gesture is checked by juice-interactions.ts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const artifacts = join(root, "artifacts/motion");
await mkdir(artifacts, { recursive: true });
const server = serve(join(root, "storybook-static"));
const browser = await launch();
const results: object[] = [];
const errors: string[] = [];
const external: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 700 }, reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    (window as any).shaderFrames = 0;
    (window as any).shaderContexts = 0;
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args: any[]) {
      if (args[0] === "webgl") (window as any).shaderContexts++;
      return context.apply(this, args as any);
    } as any;
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      (window as any).shaderFrames++;
      return draw.apply(this, args);
    };
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === server.url) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const story = async (id: string) => {
    await page.goto(`${server.url}/iframe.html?id=${id}&viewMode=story`);
    await page.locator("#storybook-root > *").waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const frames = () => page.evaluate(() => (window as any).shaderFrames as number);
  const still = async () => {
    await page.waitForFunction(
      () => document.querySelector(".jelly-specimen")?.getAttribute("data-motion") === "still",
    );
    const count = await frames();
    await page.waitForTimeout(150);
    assert.equal(await frames(), count, "no GPU draws while still");
  };
  const ripple = () => page.getByRole("button", { name: "Ripple the Ephyra specimen" });
  await story("motion-jellyspecimen--custom-artwork");
  await page.waitForFunction(
    () => (document.querySelector(".jelly-specimen img") as HTMLImageElement)?.naturalWidth > 0,
  );
  assert.equal(await page.evaluate(() => (window as any).shaderContexts), 0, "no WebGL allocation before interaction");
  await ripple().focus();
  await page.waitForFunction(() => (window as any).shaderFrames > 2);
  await page.screenshot({ path: join(artifacts, "specimen-light.png") });
  await still();
  assert.ok((await frames()) <= 64, "one ripple is bounded to about 30fps for 2.1s");
  const count = await frames();
  await ripple().press("Enter");
  await page.waitForFunction((n) => (window as any).shaderFrames > n, count);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await still();
  await ripple().press("Space");
  await still();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(100);
  await ripple().press("Space");
  await page.waitForFunction(
    () => document.querySelector(".jelly-specimen")?.getAttribute("data-motion") === "playing",
  );
  await ripple().evaluate((el) => {
    el.style.marginTop = "150vh";
  });
  await page.evaluate(() => scrollTo(0, 0));
  await still();
  await ripple().evaluate((el) => {
    el.style.marginTop = "0";
  });
  await page.waitForTimeout(100);
  await ripple().press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".jelly-specimen")?.getAttribute("data-motion") === "playing",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await still();
  await story("motion-jellyspecimen--custom-artwork-dark");
  await ripple().hover();
  await page.waitForFunction(() => (window as any).shaderFrames > 2);
  await page.screenshot({ path: join(artifacts, "specimen-dark.png") });
  await page.locator(".jelly-specimen canvas").evaluate((canvas) => {
    (canvas as HTMLCanvasElement).getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await still();
  assert.equal(await page.locator(".jelly-specimen img").evaluate((el) => getComputedStyle(el).opacity), "1");
  results.push({
    shader: "real WebGL draws",
    idle: "no allocation or frames",
    keyboard: true,
    reducedMotionChange: true,
    offscreen: "stops",
    simulatedHiddenTab: "stops",
    contextLoss: "poster",
  });

  for (const id of ["personas-personaavatar--live", "personas-personaavatar--dark-live"]) {
    await story(id);
    await page.waitForFunction(() => document.querySelectorAll(".ui-avatar--breathe").length === 6);
    assert.equal(await page.locator("video").count(), 0, "no dark video rectangles in either theme");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelectorAll(".ui-avatar--breathe").length === 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  results.push({ personas: "transparent in both themes", reducedMotion: "stills" });

  await story("motion-jellyspecimen--missing-art");
  await page.waitForFunction(() =>
    (document.querySelector(".jelly-specimen img") as HTMLImageElement)?.src.endsWith("/brand/logo.svg"),
  );
  assert.ok(await page.locator(".jelly-specimen img").evaluate((el) => (el as HTMLImageElement).naturalWidth > 0));
  await story("motion-jellyspecimen--shareable-loops");
  await page.getByRole("button", { name: "Play loops" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("figure img")].every(
      (el) => (el as HTMLImageElement).src.endsWith("-loop.webp") && (el as HTMLImageElement).naturalWidth > 0,
    ),
  );
  await page.screenshot({ path: join(artifacts, "transparent-loops.png") });
  await page.getByRole("button", { name: "Pause loops" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("figure img")].every((el) => !(el as HTMLImageElement).src.endsWith("-loop.webp")),
  );
  results.push({ missingArt: "vector mark", exportedLoops: "play and pause" });

  await story("components-connectgate--default");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const signIn = page.getByRole("link", { name: "Sign in with Not Organic" });
  await signIn.hover();
  await page.mouse.down();
  assert.equal(await signIn.evaluate((el) => getComputedStyle(el).transform), "none");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  results.push({ reducedMotionPress: "no transform" });

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 950 });
    for (const [id, label] of [
      ["components-connectgate--default", "welcome"],
      ["screens-onboardingpage--initial", "onboarding"],
      ["screens-personaspage--default", "personas"],
    ]) {
      await story(id!);
      await page
        .locator(label === "welcome" ? ".gate" : label === "onboarding" ? ".account-page" : ".personas-layout")
        .waitFor();
      await page.waitForTimeout(150);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} ${width}: no overflow`,
      );
      await page.screenshot({ path: join(artifacts, `${label}-${width}.png`), fullPage: true });
    }
    results.push({ width, overflow: false });
  }
  await page.close();

  const fallback = await browser.newPage({ reducedMotion: "no-preference" });
  await fallback.addInitScript(() => {
    const context = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args: any[]) {
      return args[0] === "webgl" ? null : context.apply(this, args as any);
    } as any;
  });
  await fallback.goto(`${server.url}/iframe.html?id=motion-jellyspecimen--custom-artwork&viewMode=story`);
  await fallback.getByRole("button", { name: "Ripple the Ephyra specimen" }).hover();
  await fallback.waitForTimeout(250);
  assert.equal(await fallback.locator(".jelly-specimen img").evaluate((el) => getComputedStyle(el).opacity), "1");
  assert.ok(await fallback.locator(".jelly-specimen img").evaluate((el) => (el as HTMLImageElement).naturalWidth > 0));
  await fallback.close();
  results.push({ unavailableWebGL: "poster" });
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await writeFile(join(artifacts, "verification.json"), JSON.stringify({ results, errors, external }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.stop();
}
