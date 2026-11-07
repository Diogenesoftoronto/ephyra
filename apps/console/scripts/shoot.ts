// Screenshot Storybook stories for design review: bun scripts/shoot.ts <storybook-dir> <out-dir> <story-id>... [--themes] [--mobile]
// Serves the static Storybook, opens each story's iframe in headless Chromium and writes PNGs. Run with `env -u LD_LIBRARY_PATH`.
import { chromium } from "playwright";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const [dir, out, ...rest] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: shoot.ts <storybook-dir> <out-dir> <story-id>...");
const ids = rest.filter((a) => !a.startsWith("--"));
const themes = rest.includes("--themes") ? ["light", "dark"] : ["light"];
const widths = rest.includes("--mobile") ? [1280, 390] : [1280];
const root = resolve(dir);
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(root, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const exe = join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");
const browser = await chromium.launch({ executablePath: exe });
const errors: string[] = [];
for (const id of ids) for (const theme of themes) for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${id}: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.port}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const file = join(out, `${id}--${theme}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  console.log(file);
  await page.close();
}
await browser.close();
server.stop();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
