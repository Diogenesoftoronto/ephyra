// The shipped Tutor panel in Storybook, with explicitly labelled local providers. No network inference or billing.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { HEADLESS_SHELL, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/tutor");
await mkdir(out, { recursive: true });
const stories = serve(join(root, "storybook-static"));
const browser = await chromium.launch({ executablePath: HEADLESS_SHELL, headless: true });
const errors: string[] = [];
try {
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage(); page.setDefaultTimeout(12_000); page.on("pageerror", e => errors.push(e.message));
    const story = (name: string) => page.goto(`${stories.url}/iframe.html?id=components-tutorpanel--${name}&viewMode=story`);
    await story("ready");
    await page.getByRole("button", { name: "Explain this trail", exact: true }).click();
    await page.locator(".tutor-answer").waitFor();
    await page.getByText("Records Tutor received", { exact: false }).click();
    await page.getByText("Tests: 42 passed, 0 failed. Production watch has not run.", { exact: true }).waitFor();
    assert.match(await page.locator(".tutor-receipt").innerText(), /ampersand-tutor-v0.1.*unknown/);
    await page.getByRole("textbox", { name: "Ask Tutor", exact: true }).fill("What remains unverified?");
    await page.getByRole("button", { name: "Ask Tutor", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".tutor-answer").length === 2);
    assert.equal(await page.getByRole("button", { name: /^Approve/ }).count(), 0);
    await page.screenshot({ path: join(out, `explanation-${width}.png`), fullPage: true });

    await page.getByRole("button", { name: "Talk with &Tutor", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Voice with &Tutor", exact: true });
    await dialog.getByRole("textbox", { name: "Or type to &Tutor", exact: true }).fill("Help me understand the landing decision.");
    await dialog.getByRole("button", { name: "Send message", exact: true }).click();
    await dialog.getByText("Your turn", { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("log").locator("article").count(), 2);
    await dialog.getByText("Session usage · unknown (1)", { exact: true }).waitFor();
    await page.screenshot({ path: join(out, `conversation-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".tutor-answer").count(), 3);

    await story("stale");
    await page.getByText("This explanation is out of date", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Ask Tutor", exact: true }).isDisabled());
    assert.ok(await page.getByRole("button", { name: "Talk with &Tutor", exact: true }).isDisabled());
    await story("uncertain");
    await page.getByText("Tutor paused", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Explain this trail", exact: true }).isDisabled());
    assert.equal(await page.locator(".tutor-answer").count(), 0);
    await story("read-only");
    assert.ok(await page.getByRole("button", { name: "Explain this trail", exact: true }).isDisabled());
    assert.ok(await page.getByRole("button", { name: "Talk with &Tutor", exact: true }).isDisabled());
    await story("unavailable");
    await page.getByText("Tutor is not connected", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Explain this trail", exact: true }).isDisabled());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await context.close();
    console.log(`Tutor explanations, sources, follow-ups, voice, stale/uncertain and spending guards passed at ${width}px.`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); stories.stop(); }
