// Real local server, recorder, stream normalizer and browser; agent output is explicitly fictional.
// No live Amp, provider, cloud, or forge calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../../server/src/compose.ts";
import { readConfig } from "../../server/src/config.ts";
import { RunRecorder } from "../../server/src/runs.ts";
import { ampThreadUrl, claudeStreamNormalizer, LineFeed } from "../../../packages/agent/src/index.ts";
import { demoRunVisual } from "../src/fake/run-visual.ts";
import { launch } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "artifacts/run-handoff");
await mkdir(out, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "ephyra-run-handoff-"));
const token = "offline-run-handoff-service-token";
const app = await compose(readConfig({ EPHYRA_API_TOKEN: token, EPHYRA_DATA_DIR: directory,
  EPHYRA_CONSOLE_DIR: join(root, "dist") }), { startJobs: false });
let forbidden = 0;
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
  if (new URL(request.url).pathname === "/fixture/forbidden") { forbidden++; return new Response("unexpected"); }
  return app.app.fetch(request);
} });
const origin = http.url.origin;
const browser = await launch();
const recorder = new RunRecorder(app.runs, app.runBroker);
const checks: unknown[] = [];
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce" });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/app/`);
    await page.getByLabel("Session token", { exact: true }).fill(token);
    await page.getByText("Local development with a service token", { exact: true }).click();
    await page.getByLabel("Service principal", { exact: true }).fill("offline-visual-reviewer");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const id = `fixture-${scheme}-${width}`;
      const run = await recorder.start({ id, trailId: null, short: null, persona: "bell", step: "research",
        engine: "amp/smart", executor: { kind: "orb", project: "Offline visual fixture" } });
      await page.goto(`${origin}/app/#/runs/${id}`);
      await page.getByRole("heading", { name: "Transcript", exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "Open Amp orb ↗", exact: true }).count(), 0);
      await page.getByText("Nothing shared yet", { exact: true }).waitFor();
      const feed = new LineFeed(claudeStreamNormalizer({ onExecutor: run.executor, threadUrl: ampThreadUrl }), run.event);
      const send = async (event: unknown) => feed.write(`${JSON.stringify(event)}\n`);
      await send({ type: "system", subtype: "init", session_id: "T-01a1b539-f083-765f-8b6b-9255cfec4fb5" });
      const openOrb = page.getByRole("link", { name: "Open Amp orb ↗", exact: true });
      await openOrb.waitFor();
      assert.equal(await openOrb.getAttribute("href"), "https://ampcode.com/threads/T-01a1b539-f083-765f-8b6b-9255cfec4fb5");
      assert.equal(await openOrb.getAttribute("target"), "_blank");
      assert.equal((await app.runs.get(id))?.status, "running", "access arrives before completion");
      const share = async (html: string) => {
        await send({ type: "assistant", message: { content: [{ type: "tool_use", id: "share", name: "bash",
          input: { command: "python3 share-visual.py" } }] } });
        await send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "share", is_error: false,
          content: `EPHYRA_VISUAL ${JSON.stringify({ ...demoRunVisual, html })}` }] } });
      };
      const probes = `<script>
try{parent.document.body.dataset.compromised='yes'}catch{document.body.dataset.parentBlocked='yes'}
try{localStorage.setItem('agent-probe','yes')}catch{document.body.dataset.storageBlocked='yes'}
fetch('${origin}/fixture/forbidden',{method:'POST',body:'untrusted'}).catch(()=>{document.body.dataset.networkBlocked='yes'});
</script>`;
      await share(demoRunVisual.html + probes);
      const frame = page.frameLocator(".run-visual-stage iframe");
      await frame.getByRole("heading", { name: "One rounding step.", exact: true }).waitFor();
      await frame.locator('body[data-network-blocked="yes"]').waitFor();
      assert.equal(await frame.locator("body").getAttribute("data-parent-blocked"), "yes");
      assert.equal(await frame.locator("body").getAttribute("data-storage-blocked"), "yes");
      assert.equal(await page.locator("body").getAttribute("data-compromised"), null);
      assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
      const initialColor = await frame.locator("body").evaluate((element) => getComputedStyle(element).color);
      await page.getByRole("radio", { name: scheme === "dark" ? "Light" : "Dark", exact: true }).click();
      await frame.locator(`html[style*="color-scheme: ${scheme === "dark" ? "light" : "dark"}"]`).waitFor();
      assert.notEqual(await frame.locator("body").evaluate((element) => getComputedStyle(element).color), initialColor);
      await page.getByRole("radio", { name: scheme === "dark" ? "Dark" : "Light", exact: true }).click();
      await frame.locator(`html[style*="color-scheme: ${scheme}"]`).waitFor();
      await frame.getByRole("slider", { name: "Number of items" }).fill("7");
      assert.equal(await frame.locator("#before").innerText(), "$2.38");
      await page.getByRole("button", { name: "Expand visual", exact: true }).focus();
      await page.keyboard.press("Control+k");
      await page.locator(".command-menu:modal").waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".command-menu:modal").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Expand visual", exact: true }).click();
      assert.equal(await page.locator("dialog:modal").count(), 1);
      await page.keyboard.press("Control+k");
      assert.equal(await page.locator(".command-menu:modal").count(), 0, "expanded visual owns modal focus");
      assert.equal(await frame.getByRole("slider").inputValue(), "7", "expansion preserves frame state");
      await frame.getByRole("button", { name: "Reset example" }).focus();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Expand visual", exact: true }).waitFor();
      assert.equal(await page.locator("dialog:modal").count(), 0);
      await share(demoRunVisual.html.replace("One rounding step.", "Updated explanation."));
      await page.getByRole("button", { name: "Load update", exact: true }).waitFor();
      assert.equal(await frame.getByRole("slider").inputValue(), "7", "streaming revisions do not reset an inspected page");
      await page.getByRole("button", { name: "Load update", exact: true }).click();
      await frame.getByRole("heading", { name: "Updated explanation.", exact: true }).waitFor();
      run.executor({ portalUrl: "https://recorded-orb.portal.example/preview" });
      await page.locator('.run-header a[href="https://recorded-orb.portal.example/preview"]').waitFor();
      await run.finish({ status: "done" });
      await page.reload();
      await frame.getByRole("heading", { name: "Updated explanation.", exact: true }).waitFor();
      assert.ok(await page.locator(".run-header").getByText("Done", { exact: true }).isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const clipped = await page.locator("button, h1, h2, iframe").evaluateAll((elements) => elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map((element) => element.tagName));
      assert.deepEqual(clipped, []);
      await page.screenshot({ path: join(out, `run-${width}-${scheme}.png`), fullPage: true });
      checks.push({ width, scheme, result: "pass", checks: "live access, real SSE, stream-published visual, isolation, interaction, expand, revision pin, reload" });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.equal(forbidden, 0, "untrusted frame never called the host endpoint");
  await writeFile(join(out, "checks.json"), JSON.stringify(checks, null, 2));
  console.log(`PASS ${checks.length} local run handoff flows; no live provider calls`);
} finally { await browser.close(); http.stop(true); await app.close(); await rm(directory, { recursive: true, force: true }); }
