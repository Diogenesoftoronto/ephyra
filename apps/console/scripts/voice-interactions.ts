// Browser proof with explicit fixtures, including real MediaRecorder/Web Audio against Chromium's synthetic microphone.
// No provider, account, forge or cloud calls. Build Storybook first.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { HEADLESS_SHELL, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/voice");
await mkdir(out, { recursive: true });
const stories = serve(join(root, "storybook-static"));
const browser = await chromium.launch({ executablePath: HEADLESS_SHELL, headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const errors: string[] = [];
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 860 }, permissions: ["microphone"], reducedMotion: "reduce" });
    const p = await context.newPage(); p.on("pageerror", e => errors.push(e.message));
    const story = (name: string) => p.goto(`${stories.url}/iframe.html?id=voice-conversation--${name}&viewMode=story`);
    const dialog = p.getByRole("dialog", { name: "Voice with Velum" });
    await story("interactive-conversation");
    await p.getByRole("button", { name: "Talk with Velum", exact: true }).click();
    await dialog.getByRole("button", { name: "Start recording", exact: true }).click();
    await dialog.getByRole("button", { name: "Send turn", exact: true }).waitFor();
    await p.screenshot({ path: join(out, `listening-${width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Send turn", exact: true }).click();
    await dialog.getByText("Your turn", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("log").locator("article").count(), 2);
    await dialog.getByText("Session usage · unknown (3)", { exact: true }).waitFor();
    await p.screenshot({ path: join(out, `conversation-${width}.png`), fullPage: true });
    await p.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await p.getByLabel("Fixture requests").textContent(), "transcribe, reply, speak");

    await story("interactive-conversation");
    await p.getByRole("button", { name: "Dictate", exact: true }).click();
    await dialog.getByRole("button", { name: "Start recording", exact: true }).click();
    await dialog.getByRole("button", { name: "Transcribe", exact: true }).click();
    await dialog.getByLabel("Your words", { exact: true }).fill("My corrected policy instruction.");
    await dialog.getByRole("button", { name: "Insert text", exact: true }).click();
    assert.equal(await p.getByLabel("Message draft", { exact: true }).inputValue(), "Existing words. My corrected policy instruction.");
    assert.equal(await p.getByLabel("Fixture requests").textContent(), "transcribe");

    await story("interactive-draft");
    await p.getByRole("heading", { name: "autonomy.md", exact: true }).waitFor();
    await p.getByRole("button", { name: "Talk with Velum", exact: true }).first().click();
    await dialog.getByLabel("Or type to Velum", { exact: true }).fill("Add an area for billing.");
    await dialog.getByRole("button", { name: "Send message", exact: true }).click();
    await dialog.getByText("Proposal ready. Close voice to review it in the document conversation.", { exact: true }).waitFor();
    await dialog.getByText("Your turn", { exact: true }).waitFor();
    await p.screenshot({ path: join(out, `proposal-${width}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Close voice", exact: true }).click();
    if (width < 1000) await p.getByRole("radio", { name: "Velum", exact: true }).check();
    await p.locator(".proposal").getByRole("button", { name: "Use this proposal", exact: true }).last().waitFor();
    await p.getByRole("radio", { name: "Document", exact: true }).check();
    const editor = p.locator(".editor-text"); await editor.fill(`${await editor.inputValue()}\nLocal edit.`);
    for (const button of await p.getByRole("button", { name: "Talk with Velum", exact: true }).all()) assert.ok(await button.isDisabled());

    await story("read-only-controls");
    assert.ok(await p.getByRole("button", { name: "Talk with Velum", exact: true }).isDisabled());
    assert.ok(await p.getByRole("button", { name: "Dictate", exact: true }).isDisabled());
    assert.ok(await p.getByRole("button", { name: "Read fixture evidence aloud", exact: true }).isDisabled());
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close();
    console.log(`Voice conversation, dictation, draft proposals and permissions passed at ${width}px.`);
  }
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 860 } });
  const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    const captures: MediaStream[] = []; (window as any).__voiceCaptures = captures;
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await get(constraints); captures.push(stream); return stream; };
  });
  await page.goto(`${stories.url}/iframe.html?id=voice-conversation--browser-audio&viewMode=story`);
  await page.getByRole("button", { name: "Talk with Velum", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Voice with Velum" });
  await dialog.getByRole("button", { name: "Start recording", exact: true }).click();
  await dialog.getByRole("button", { name: "Send turn", exact: true }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")) > 0);
  await dialog.getByRole("button", { name: "Send turn", exact: true }).click();
  await dialog.getByText("Your turn", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Fixture requests").textContent(), "transcribe, reply, speak");
  assert.equal(await page.evaluate(() => (window as any).__voiceCaptures[0].getTracks().every((t: MediaStreamTrack) => t.readyState === "ended")), true);
  await dialog.getByRole("button", { name: "Start recording", exact: true }).click();
  await dialog.getByRole("button", { name: "Send turn", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => (window as any).__voiceCaptures.every((s: MediaStream) => s.getTracks().every(t => t.readyState === "ended"))), true);
  await context.close();
  assert.deepEqual(errors, []);
  console.log("Browser MediaRecorder, measured levels, WAV decoding/playback and microphone cleanup passed with a synthetic device.");
} finally { await browser.close(); stories.stop(); }
