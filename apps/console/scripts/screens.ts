// Screenshots of the built app (demo data) and of chosen stories, at 1280px and 375px, light and dark.
//   env -u LD_LIBRARY_PATH bun scripts/screens.ts [--no-build] [--only=<screen name>] [--stories=<id>,<id>…]
// Output: apps/console/.screens/  (gitignored)
import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";
import { makeTrails } from "../src/fake/fixtures.ts";
import { RUN_IDS } from "../src/fake/runs.ts";

const root = join(import.meta.dir, "..");
const out = join(root, ".screens");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const storyIds = args.find((a) => a.startsWith("--stories="))?.slice(10).split(",").filter(Boolean) ?? [];

if (!args.includes("--no-build")) {
  const builds = await Promise.all([$`bun run build`.cwd(root).quiet().nothrow(), $`bun run build-storybook`.cwd(root).quiet().nothrow()]);
  for (const b of builds) if (b.exitCode !== 0) { console.error(b.stderr.toString()); process.exit(1); }
}

const trailId = (hex: string) => makeTrails(0).find((t) => t.short === `T-${hex}`)!.id;
type Shot = { name: string; hash: string; act?: (page: import("playwright").Page) => Promise<void> };
const click = (label: string) => async (page: import("playwright").Page) => { await page.getByRole("radio", { name: label, exact: true }).click(); await page.waitForTimeout(300); };

const SCREENS: Shot[] = [
  { name: "overview", hash: "#/overview" },
  { name: "usage", hash: "#/usage" },
  { name: "inbox", hash: "#/inbox" },
  { name: "trail-checkpoint-c", hash: `#/inbox/${trailId("c2d018")}` },
  { name: "trail-checkpoint-a", hash: `#/inbox/${trailId("7f3a2c")}` },
  { name: "trail-spend", hash: `#/inbox/${trailId("3a77e1")}` },
  { name: "runs", hash: "#/runs" },
  { name: "run-orb-live", hash: `#/runs/${RUN_IDS.orb}` },
  { name: "run-failed", hash: `#/runs/${RUN_IDS.failed}` },
  { name: "workspace-map", hash: "#/workspace" },
  { name: "draft-map", hash: "#/workspace/d-1" },
  { name: "draft-document", hash: "#/workspace/d-1", act: click("Document") },
  { name: "draft-changes", hash: "#/workspace/d-1", act: click("Changes") },
  { name: "personas", hash: "#/personas" },
].filter((s) => !only || s.name.includes(only));

const appServer = serve(join(root, "dist"), "/app/");
const sbServer = serve(join(root, "storybook-static"));
const browser = await launch();
const problems: string[] = [];

for (const width of [1280, 375]) {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
    for (const shot of SCREENS) {
      const page = await ctx.newPage();
      page.on("console", (m) => { if (m.type() === "error" && !/\/personas\//.test(m.location().url)) problems.push(`${shot.name}@${width}/${scheme}: ${m.text().slice(0, 200)}`); });
      page.on("pageerror", (e) => problems.push(`${shot.name}@${width}/${scheme}: ${e.message.slice(0, 200)}`));
      await page.goto(`${appServer.url}/app/?demo=1${shot.hash}`, { waitUntil: "load" });
      await page.waitForTimeout(900);
      await shot.act?.(page);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1 && width < 500) problems.push(`${shot.name}@${width}/${scheme}: horizontal overflow ${over}px`);
      await page.screenshot({ path: join(out, `app-${shot.name}-${width}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    for (const id of storyIds) {
      const page = await ctx.newPage();
      await page.goto(`${sbServer.url}/iframe.html?id=${id}&viewMode=story&globals=theme:${scheme}`, { waitUntil: "load" });
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `story-${id}-${width}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
appServer.stop();
sbServer.stop();
console.log(`Screenshots in ${out}`);
if (problems.length) { console.error([...new Set(problems)].join("\n")); process.exit(1); }
