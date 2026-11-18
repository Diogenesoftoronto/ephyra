// Local browser checks with explicit fictional data. No provider, forge or cloud calls.
// Build the app and Storybook first, then: bun run interactions [--only=<case>]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/interactions");
await mkdir(out, { recursive: true });
const app = serve(join(root, "dist"), "/app/");
const stories = serve(join(root, "storybook-static"));
const browser = await launch();
const only = process.argv.find((v) => v.startsWith("--only="))?.slice(7);
const cases: Array<{ name: string; width: number; run: (p: Page) => Promise<void> }> = [];
const demo = (p: Page, hash: string) => p.goto(`${app.url}/app/?demo=1#/${hash}`);
const story = (p: Page, id: string) => p.goto(`${stories.url}/iframe.html?id=${id}&viewMode=story`);
const shot = (p: Page, name: string) => p.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const visible = (p: Page, text: string | RegExp) => p.getByText(text, { exact: true }).first().waitFor();
const noOverflow = async (p: Page) =>
  assert.ok(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    "page overflows its viewport",
  );

cases.push({
  name: "draft",
  width: 1440,
  run: async (p) => {
    await demo(p, "workspace/d-1");
    await p.getByRole("heading", { name: "autonomy.md", exact: true }).waitFor();
    await p.getByRole("radio", { name: "Document", exact: true }).check();
    const editor = p.locator(".editor-text");
    const content = await editor.inputValue();
    await editor.fill(`${content}\n<!-- edited in the local browser check -->\n`);
    assert.ok(await p.getByRole("button", { name: "Publish…", exact: true }).isDisabled());
    assert.ok(await p.getByRole("radio", { name: "Map", exact: true }).isDisabled());
    assert.ok(await p.getByLabel("Message Velum", { exact: true }).isDisabled());
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await visible(p, "Saved");
    await p.getByRole("radio", { name: "Map", exact: true }).check();
    const area = p.locator(".area-row").first();
    await area.locator("button.area-row-head").click();
    const intent = area.getByLabel("What this part of the app is", { exact: true });
    await intent.fill(`${await intent.inputValue()} Browser-checked intent.`);
    assert.ok(await p.getByRole("button", { name: "Publish…", exact: true }).isDisabled());
    await p.getByRole("button", { name: "Save 1 change to the draft", exact: true }).click();
    await p.getByRole("button", { name: "No unsaved changes", exact: true }).waitFor();
    const form = p.locator(".gu-form").first();
    const duration = form.getByLabel("Watch after landing amount", { exact: true });
    assert.ok((await duration.boundingBox())!.width >= 72, "duration amount stays readable beside its unit");
    assert.equal(await duration.inputValue(), "2");
    await duration.fill("3");
    await form.getByLabel("Area name", { exact: true }).fill("billing-review");
    await form.getByRole("button", { name: "Apply to draft", exact: true }).click();
    await form.getByText("Applied to the draft", { exact: true }).waitFor();
    await p.locator('.area-row[data-area="billing-review"]').waitFor();
    await p.getByLabel("Message Velum", { exact: true }).fill("Add an area for billing.");
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const proposal = p.locator(".proposal").last();
    await proposal
      .getByText("Add a billing area: high risk, Propose level, lands as a quest ref.", { exact: true })
      .waitFor();
    await proposal.getByRole("button", { name: "Use this proposal", exact: true }).click();
    await proposal.getByText("In the draft", { exact: true }).waitFor();
    await p.getByRole("radio", { name: "Changes", exact: true }).check();
    await p.getByRole("figure", { name: "Changes to autonomy.md", exact: true }).waitFor();
    await shot(p, "draft-desktop-light");
    await p.getByRole("button", { name: "Publish…", exact: true }).click();
    await p.getByRole("button", { name: "Yes, publish", exact: true }).click();
    await p.getByRole("heading", { name: "Published", exact: true }).waitFor();
    await visible(p, "refs/ephyra/policy/d-1");
    assert.ok(await p.getByLabel("Message Velum", { exact: true }).isDisabled());
  },
});

for (const width of [1280, 375])
  cases.push({
    name: `policy-board-${width}`,
    width,
    run: async (p) => {
      // An open draft owns the document: the board is read-only and points at the draft.
      await story(p, "screens-workspacepage--default");
      await p.getByRole("button", { name: "Continue the draft", exact: true }).waitFor();
      assert.equal(await p.getByRole("button", { name: "Add an area", exact: true }).count(), 0);
      const readonly = p.locator(".area-row").first().locator("button.area-row-head");
      await readonly.click();
      assert.equal(await readonly.getAttribute("aria-expanded"), "true");
      assert.equal(await p.locator(".area-detail textarea").count(), 0, "a locked board has no fields");
      await noOverflow(p);

      await story(p, "screens-workspacepage--editable");
      await p.getByRole("button", { name: "Add an area", exact: true }).waitFor();
      const rows = p.locator(".area-row");
      const heads = p.locator("button.area-row-head");
      assert.ok((await rows.count()) > 1, "the fixture has several areas");
      for (const box of await heads.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height)))
        assert.ok(box >= 44 && box <= (width > 700 ? 48 : 110), `row height ${box}`);
      await p.getByRole("img", { name: /^Autonomy: .+, [1-5] of 5$/ }).first().waitFor();
      await heads.nth(0).click();
      await heads.nth(1).click();
      assert.equal(await p.locator(".area-detail").count(), 1, "one row open at a time");
      assert.equal(await heads.nth(0).getAttribute("aria-expanded"), "false");
      const open = rows.nth(1);
      const before = await open.getByRole("radio", { checked: true }).first().getAttribute("value");
      const target = before === "watch" ? "research" : "watch";
      await open.locator(`.ladder-track label:has(input[value="${target}"])`).click();
      await open.getByText("changed", { exact: true }).waitFor();
      const bar = p.getByRole("group", { name: "Unpublished edits", exact: true });
      await bar.getByText("1 change", { exact: true }).waitFor();
      assert.ok(await p.getByRole("radio", { name: "Raw", exact: true }).isDisabled(), "unsaved map edits block the switch");
      await noOverflow(p);
      await shot(p, `policy-board-${width}-editing`);
      await bar.getByRole("button", { name: "Discard", exact: true }).click();
      assert.equal(await bar.count(), 0);

      await p.getByRole("radio", { name: "Raw", exact: true }).check();
      const editor = p.locator(".editor-text");
      assert.ok((await editor.inputValue()).includes("## area:"), "raw shows the published autonomy.md");
      await p.getByText("No edits", { exact: true }).waitFor();
      await editor.fill(`${await editor.inputValue()}\n<!-- raw edit -->\n`);
      assert.ok(await p.getByRole("radio", { name: "Map", exact: true }).isDisabled(), "unsaved raw edits block the switch");
      await p.getByRole("button", { name: "Revert", exact: true }).click();
      await p.getByRole("radio", { name: "Map", exact: true }).check();

      await heads.nth(1).click();
      await rows.nth(1).locator(`.ladder-track label:has(input[value="${target}"])`).click();
      await p.getByRole("button", { name: "Review and publish", exact: true }).click();
      await p.waitForFunction(() => /^#\/workspace\/d-\d+$/.test(location.hash));

      // Unknown outcome: the edits stay, nothing is called saved, and the draft is offered for checking.
      await story(p, "screens-workspacepage--save-outcome-unknown");
      await p.getByRole("button", { name: "Add an area", exact: true }).waitFor();
      await heads.nth(0).click();
      const first = rows.nth(0);
      const was = await first.getByRole("radio", { checked: true }).first().getAttribute("value");
      await first.locator(`.ladder-track label:has(input[value="${was === "watch" ? "research" : "watch"}"])`).click();
      await p.getByRole("button", { name: "Review and publish", exact: true }).click();
      await p.getByText("We could not confirm that change.", { exact: true }).waitFor();
      await p.getByRole("link", { name: "Open the draft to check", exact: true }).waitFor();
      await p.getByRole("group", { name: "Unpublished edits", exact: true }).getByText("1 change", { exact: true }).waitFor();
      assert.equal(await p.evaluate(() => location.hash), "", "an unconfirmed save does not navigate");
    },
  });

cases.push({
  name: "usage",
  width: 1280,
  run: async (p) => {
    await demo(p, "usage");
    const ledger = p.getByRole("table", { name: "Usage ledger", exact: true });
    await ledger.waitFor();
    const initial = await ledger.locator("tbody tr").count();
    await p.getByRole("button", { name: "Show more", exact: true }).click();
    await p.waitForFunction((n) => document.querySelectorAll(".ledger tbody tr").length > n, initial);
    const filters = p.getByRole("form", { name: "Ledger filters" });
    await filters.getByLabel("Persona", { exact: true }).selectOption("nema");
    await p.waitForFunction(() => {
      const cells = [...document.querySelectorAll(".ledger tbody tr td:nth-child(2)")];
      return cells.length > 0 && cells.every((e) => e.textContent?.includes("Nema"));
    });
    await filters.getByRole("button", { name: "Clear filters" }).click();
    await filters.getByLabel("Result", { exact: true }).selectOption("unknown-cost");
    await p.waitForFunction(() => {
      const cells = [...document.querySelectorAll(".ledger tbody tr td:nth-child(7)")];
      return cells.length > 0 && cells.every((e) => e.textContent?.includes("unknown"));
    });
    await p.getByRole("radio", { name: "14 days", exact: true }).check();
    await p.getByRole("heading", { name: "Spending pace", exact: true }).waitFor();
    await shot(p, "usage-desktop-light");
  },
});

cases.push({
  name: "mobile",
  width: 375,
  run: async (p) => {
    await demo(p, "overview");
    await p.getByRole("heading", { name: "Needs your decision", exact: true }).waitFor();
    await noOverflow(p);
    await shot(p, "overview-mobile-light");
    await p.getByRole("button", { name: "More", exact: true }).click();
    await p.getByRole("menuitem", { name: "Personas", exact: true }).click();
    await p.getByRole("button", { name: /^Nema / }).click();
    await p.getByRole("heading", { name: "Nema", exact: true }).waitFor();
    await noOverflow(p);
    await p.getByRole("radio", { name: "Dark", exact: true }).click();
    await shot(p, "persona-mobile-dark");
    assert.equal(
      await p.locator('.persona-card video, .persona-card img[src*=".gif"]').count(),
      0,
      "reduced motion must use a still",
    );
    await p.getByRole("button", { name: "← All personas", exact: true }).click();
    await p.getByRole("button", { name: /^Velum / }).waitFor();
    await p.getByRole("button", { name: "More", exact: true }).click();
    await p.getByRole("menuitem", { name: "Workspace", exact: true }).click();
    await p.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
    await noOverflow(p);
    await p.locator('a.draft-row[href="#/workspace/d-1"]').click();
    await p.getByRole("radio", { name: "Velum", exact: true }).check();
    await p.getByLabel("Message Velum", { exact: true }).waitFor();
    await noOverflow(p);
    await shot(p, "draft-mobile-dark");
  },
});

cases.push({
  name: "runs",
  width: 1280,
  run: async (p) => {
    await demo(p, "runs");
    await p.locator('.run-row__link[href="#/runs/run-orb-7qm2x"]').click();
    await p.getByRole("heading", { name: "Transcript", exact: true }).waitFor();
    await visible(p, "policy: reject");
    await visible(p, "Waiting for the proof runner");
    await p.getByRole("radio", { name: "Dark", exact: true }).click();
    await shot(p, "run-desktop-dark");
  },
});

cases.push({
  name: "guards",
  width: 1280,
  run: async (p) => {
    await story(p, "screens-inboxpage--stale");
    await visible(p, "This approval is stale.");
    assert.ok(await p.getByRole("button", { name: "Approve landing", exact: true }).isDisabled());
    await story(p, "screens-inboxpage--read-only");
    await visible(p, "Only approvers can decide. You can read everything here.");
    assert.ok(await p.getByRole("button", { name: "Approve landing", exact: true }).isDisabled());
    await story(p, "screens-inboxpage--landing");
    await p.getByRole("button", { name: "Approve landing", exact: true }).click();
    await visible(p, "approve");
    await story(p, "screens-draftpage--read-only");
    await p.getByRole("button", { name: "Publish…", exact: true }).waitFor();
    assert.ok(await p.getByRole("button", { name: "Publish…", exact: true }).isDisabled());
    assert.ok(await p.getByLabel("Message Velum", { exact: true }).isDisabled());
    await story(p, "screens-draftpage--publish-conflict");
    await p.getByRole("button", { name: "Publish…", exact: true }).click();
    await p.getByRole("button", { name: "Yes, publish", exact: true }).click();
    await visible(p, "Publishing was refused.");
    await p.getByRole("button", { name: "Keep editing", exact: true }).click();
    await p.getByRole("radio", { name: "Document", exact: true }).check();
    assert.ok((await p.locator(".editor-text").inputValue()).length > 100, "conflict preserves the draft");
    await story(p, "screens-draftpage--model-unavailable");
    await p.getByLabel("Message Velum", { exact: true }).fill("Add an area for billing.");
    await p.getByRole("button", { name: "Send", exact: true }).click();
    await visible(p, /Velum is unavailable/);
    assert.equal(await p.locator(".proposal").count(), 0, "unavailable model must not invent a proposal");
    await story(p, "usage-ledger--no-matches-yet");
    await visible(p, "No matches in the loaded entries");
    await p.getByRole("button", { name: "Show more", exact: true }).click();
    await p.getByRole("table", { name: "Usage ledger", exact: true }).waitFor();
  },
});

let failed = false;
try {
  for (const c of cases.filter((c) => !only || c.name === only)) {
    const ctx = await browser.newContext({
      viewport: { width: c.width, height: 900 },
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    const p = await ctx.newPage();
    p.setDefaultTimeout(12_000);
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    try {
      await c.run(p);
      assert.deepEqual(errors, [], "browser errors");
      console.log(`PASS ${c.name}`);
    } catch (e) {
      failed = true;
      console.error(`FAIL ${c.name}`, e);
      await shot(p, `${c.name}-failure`);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  app.stop();
  stories.stop();
}
console.log(`Screenshots: ${out}`);
if (failed) process.exit(1);
