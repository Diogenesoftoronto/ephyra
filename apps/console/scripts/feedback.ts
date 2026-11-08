import assert from "node:assert/strict";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
const site = serve(join(import.meta.dir, "../storybook-static"));
const browser = await launch();
try {
  const context = await browser.newContext(); const page = await context.newPage();
  await context.addInitScript(() => {
    (window as any).cuePlays = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      if (this instanceof HTMLAudioElement) (window as any).cuePlays.push(this.src);
      return original.call(this);
    };
  });
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/juice/sounds/")) requests.push(request.url()); });
  const url = `${site.url}/iframe.html?id=motion-soundtoggle--cues&viewMode=story`;
  await page.goto(url); const toggle = page.getByRole("switch", { name: "Interface sounds" });
  await toggle.waitFor(); assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await page.getByRole("button", { name: "copy", exact: true }).click();
  assert.equal(requests.length, 0, "Off means no requests or playback");
  await toggle.click(); await page.waitForFunction(() => (window as any).cuePlays.length === 1);
  await page.waitForTimeout(550);
  await page.getByRole("button", { name: "connected", exact: true }).dblclick();
  assert.equal(await page.evaluate(() => (window as any).cuePlays.length), 2, "Rapid duplicate events produce one cue");
  const second = await context.newPage(); await second.goto(url);
  await second.getByRole("switch", { name: "Interface sounds" }).waitFor();
  assert.equal(await second.getByRole("switch").getAttribute("aria-checked"), "true");
  await second.getByRole("switch").click();
  await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
  await second.close(); await page.reload();
  assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "false");
  for (const cue of ["touch", "copy", "connected", "invitation", "message", "attention"]) {
    const duration = await page.evaluate(async cue => {
      const context = new AudioContext();
      try { return (await context.decodeAudioData(await (await fetch(`/app/juice/sounds/${cue}.mp3`)).arrayBuffer())).duration; }
      finally { await context.close(); }
    }, cue);
    assert.ok(duration > 0 && duration < 1.5, `${cue} decodes as a short cue`);
  }
  console.log("PASS default-off/no-preload, opt-in, rate limiting, shared mute, persistence and six browser-decoded cues");
  await context.close();
} finally { await browser.close(); site.stop(); }
