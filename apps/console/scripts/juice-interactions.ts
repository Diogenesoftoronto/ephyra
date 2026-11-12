// Offline browser proof of interaction behavior. External repository discovery uses explicit fixtures.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/juice"); mkdirSync(out, { recursive: true });
const site = serve(join(root, "storybook-static"));
const browser = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://api.github.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/slow/")) await new Promise(resolve => setTimeout(resolve, 500));
    if (url.pathname.includes("/limited/")) return route.fulfill({ status: 403, body: "{}", contentType: "application/json" });
    const owner = url.pathname.split("/")[2];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ full_name: `${owner}/application`, default_branch: "trunk", description: "Offline repository fixture" }]) });
  });
  await page.goto(`${site.url}/iframe.html?id=screens-onboardingpage--initial&viewMode=story`);
  await page.getByText("Find a public GitHub repository", { exact: true }).click();
  const owner = page.getByLabel("GitHub username or organization");
  await owner.fill("octocat");
  await owner.press("Enter");
  await page.getByRole("button", { name: /octocat\/application/ }).click();
  assert.equal(await page.getByLabel("Repository address", { exact: true }).inputValue(), "https://github.com/octocat/application.git");
  assert.equal(await page.getByLabel("Branch (optional)").inputValue(), "trunk");
  assert.ok(await page.getByRole("button", { name: "Connect and set up automatically" }).isVisible(), "Discovery never submits repository settings");
  await owner.fill("slow"); await owner.press("Enter"); await owner.fill("fresh"); await owner.press("Enter");
  await page.getByRole("button", { name: /fresh\/application/ }).waitFor();
  await page.waitForTimeout(650);
  assert.equal(await page.getByRole("button", { name: /slow\/application/ }).count(), 0, "Aborted discovery cannot replace current account results");
  await owner.fill("limited"); await owner.press("Enter");
  await page.getByText("GitHub’s public lookup limit was reached. Paste a repository link below.").waitFor();
  assert.ok(await page.getByLabel("Repository address", { exact: true }).isEditable());
  await page.screenshot({ path: join(out, "repository-picker.png"), fullPage: true });
  console.log("PASS repository selection, default branch, stale lookup cancellation, rate-limit recovery");

  const videoRequests: string[] = [];
  page.on("request", request => { if (request.url().endsWith("/characters/ephyra-v2.webm")) videoRequests.push(request.url()); });
  await page.goto(`${site.url}/iframe.html?id=motion-charactergesture--default&viewMode=story`);
  const character = page.getByRole("button", { name: "Greet Ephyra", exact: true });
  await character.waitFor();
  assert.equal(videoRequests.length, 0, "Character movies do not preload");
  await character.focus(); await character.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>(".character-gesture video")!.currentTime > .5);
  const pixel = await page.locator("video").evaluate(movie => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 240;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(movie as HTMLVideoElement, 0, 0, 240, 240);
    return [...ctx.getImageData(1, 1, 1, 1).data];
  });
  assert.equal(pixel[3], 0, "Character video background is transparent in the browser");
  await page.screenshot({ path: join(out, "character-alpha-light.png") });
  await page.waitForFunction(() => document.querySelector(".character-gesture")?.getAttribute("data-motion") === "still", { timeout: 10000 });
  assert.equal(await page.locator("video").getAttribute("loop"), null, "Greeting ends instead of looping");
  await character.press("Enter");
  await page.getByRole("button", { name: "Pause greet ephyra" }).waitFor();
  await page.getByRole("button", { name: "Pause greet ephyra" }).press("Enter");
  await page.waitForFunction(() => document.querySelector(".character-gesture")?.getAttribute("data-motion") === "still");
  console.log("PASS finite character playback, alpha transparency, keyboard replay and pause");

  await page.goto(`${site.url}/iframe.html?id=motion-charactergesture--all-characters&viewMode=story`);
  for (const persona of ["ephyra", "rho", "bell", "nema", "lappet", "turri", "velum"]) {
    const greeting = page.getByRole("button", { name: `Greet ${persona}`, exact: true });
    await greeting.focus(); await greeting.press("Enter");
    const movie = page.locator(`video[src$="/${persona === "ephyra" ? "ephyra-v2" : persona}.webm"]`);
    await movie.waitFor({ state: "attached" });
    await page.waitForFunction(name => {
      const movie = document.querySelector<HTMLVideoElement>(`video[src$="/${name === "ephyra" ? "ephyra-v2" : name}.webm"]`);
      return movie && movie.currentTime > .3 && !movie.paused;
    }, persona);
    const alpha = await movie.evaluate(element => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 160;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(element as HTMLVideoElement, 0, 0, 160, 160);
      const data = ctx.getImageData(0, 0, 160, 160).data;
      let visible = 0; for (let index = 3; index < data.length; index += 4) if (data[index]! > 100) visible++;
      return { corner: data[3], visible };
    });
    assert.equal(alpha.corner, 0, `${persona} retains its alpha channel`);
    assert.ok(alpha.visible > 1000, `${persona} has a visible decoded character`);
    await page.getByRole("button", { name: `Pause greet ${persona}`, exact: true }).press("Enter");
  }
  console.log("PASS all seven selected character clips decode with visible bodies and transparent backgrounds");

  await page.goto(`${site.url}/iframe.html?id=motion-charactergesture--opaque-decoder-fallback&viewMode=story`);
  await page.getByRole("button", { name: "Greet Ephyra", exact: true }).focus();
  await page.getByRole("button", { name: "Greet Ephyra", exact: true }).press("Enter");
  await page.waitForFunction(() => {
    const movie = document.querySelector<HTMLVideoElement>(".character-gesture video");
    return movie && !movie.hasAttribute("src") && document.querySelector(".character-gesture")?.getAttribute("data-motion") === "still";
  });
  assert.equal(await page.locator(".character-gesture > img").evaluate(image => getComputedStyle(image).opacity), "1");
  console.log("PASS opaque decoder result falls back to the approved still");

  const reduced = await browser.newContext({ reducedMotion: "reduce" });
  const still = await reduced.newPage(); let fetched = 0;
  still.on("request", request => { if (request.url().endsWith("/characters/ephyra-v2.webm")) fetched++; });
  await still.goto(`${site.url}/iframe.html?id=motion-charactergesture--default&viewMode=story`);
  await still.getByRole("button", { name: "Greet Ephyra", exact: true }).click();
  assert.equal(await still.locator("video").getAttribute("src"), null);
  assert.equal(fetched, 0);
  assert.equal(await still.locator(".character-gesture").getAttribute("data-motion"), "still");
  await reduced.close();
  assert.deepEqual(errors, []);
  console.log("PASS reduced-motion avoids video download and playback");
  await context.close();
} finally { await browser.close(); site.stop(); }
