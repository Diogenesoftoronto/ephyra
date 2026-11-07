// Smoke render: build Storybook, then render every story headlessly at 1280px and 375px.
// Fails on any console error, page error, Storybook error display, or horizontal page overflow at 375px.
//   env -u LD_LIBRARY_PATH bun scripts/smoke.ts [--no-build] [--filter=<text in story id>]
import { $ } from "bun";
import { join } from "node:path";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith("--filter="))?.slice(9);
const WIDTHS = [1280, 375] as const;
const CONCURRENCY = 2;

if (!args.includes("--no-build")) {
  const build = await $`bun run build-storybook`.cwd(root).quiet().nothrow();
  if (build.exitCode !== 0) { console.error(build.stdout.toString(), build.stderr.toString()); process.exit(1); }
}

const dir = join(root, "storybook-static");
const server = serve(dir);
const index = await (await fetch(`${server.url}/index.json`)).json() as { entries: Record<string, { type: string; id: string; title: string; name: string }> };
const stories = Object.values(index.entries).filter((e) => e.type === "story" && (!filter || e.id.includes(filter)));
if (stories.length === 0) {
  server.stop();
  throw new Error(`No stories matched ${filter ?? "the Storybook index"}`);
}
console.log(`Rendering ${stories.length} stories at ${WIDTHS.join("px and ")}px`);

type Failure = { story: string; width: number; problems: string[] };
const failures: Failure[] = [];
const browser = await launch();

async function check(story: { id: string; title: string; name: string }, width: number, ctx: Awaited<ReturnType<typeof browser.newContext>>) {
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    problems.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url().slice(0, 120)}`));
  try {
    await page.goto(`${server.url}/iframe.html?id=${story.id}&viewMode=story`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForFunction(() => document.body.classList.contains("sb-show-main") || document.body.classList.contains("sb-show-errordisplay"), null, { timeout: 15_000 });
    await page.waitForTimeout(350);
    const err = await page.evaluate(() => document.body.classList.contains("sb-show-errordisplay")
      ? document.querySelector("#error-message")?.textContent ?? "story error" : null);
    if (err) problems.push(`story error: ${err.slice(0, 300)}`);
    const empty = await page.evaluate(() => (document.querySelector("#storybook-root")?.childElementCount ?? 0) === 0 && !document.querySelector("#storybook-docs")?.childElementCount);
    if (empty && !err) problems.push("rendered nothing");
    if (width < 500) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`horizontal overflow: page is ${overflow}px wider than the viewport`);
    }
  } catch (e) {
    problems.push(`render failed: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    await page.close();
  }
  if (problems.length) failures.push({ story: `${story.title} / ${story.name} (${story.id})`, width, problems: [...new Set(problems)] });
}

const started = Date.now();
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < stories.length) {
      await check(stories[next++]!, width, ctx);
      if (next % 30 === 0) console.log(`${width}px: ${next}/${stories.length}`);
    }
  }));
  await ctx.close();
}
await browser.close();
server.stop();

if (failures.length) {
  console.error(`\n${failures.length} failing render(s):`);
  for (const f of failures) console.error(`- ${f.story} @ ${f.width}px\n    ${f.problems.join("\n    ")}`);
  process.exit(1);
}
console.log(`All ${stories.length} stories rendered at ${WIDTHS.join("px and ")}px with no console errors (${((Date.now() - started) / 1000).toFixed(0)}s).`);
