/**
 * Screenshots and measurements for the design lab, so layouts are compared with numbers and not by taste.
 *
 *   env -u LD_LIBRARY_PATH bun scripts/lab-shots.ts [--no-build] [--video] [--only=a,h]
 *
 * Writes PNGs and `metrics.json` to apps/console/.screens/lab/ (gitignored). Exits 1 on a console error,
 * a page error or horizontal overflow, so it doubles as the lab's smoke test.
 */
import { $ } from "bun";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { launch, serve } from "./browser.ts";

const root = join(import.meta.dir, "..");
const out = join(root, ".screens", "lab");
const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7).split(",") ?? null;

const LAYOUTS = ["a", "b", "c", "d", "e", "f", "h"] as const;
const NAMES: Record<string, string> = {
  a: "Water column", b: "Loop dial", c: "Logbook", d: "Triage bench", e: "Tide map", f: "Stage lanes", h: "Column and bench",
};
const VIEWPORTS = [{ name: "wide", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }] as const;
const THEMES = ["light", "dark"] as const;

export interface LayoutMetrics {
  layout: string; name: string; viewport: string; theme: string;
  /** The fleet sentence is fully inside the first viewport. */
  fleetInFirst: boolean;
  /** Quests with at least one mark fully inside the first viewport, of all quests in the page. */
  questsInFirst: number; questsTotal: number;
  /** Visible `[data-primary]` actions. The rule is exactly one. */
  primaryCount: number; primaryInFirst: boolean; primaryY: number | null;
  /** The selected quest's one-line state ("Waiting for you to approve the landing") is inside the first viewport. */
  detailInFirst: boolean;
  /** How many of the three glance questions (what is the fleet doing, what needs me, what is this quest doing) the first viewport answers. */
  glance: number;
  /** Bordered or filled-and-rounded surfaces that sit inside another one. */
  nestedBoxes: number;
  /** Distinct x positions where a block of text starts, in the first viewport (2px tolerance). Fewer is calmer. Plotted marks are left out. */
  leftEdges: number;
  /** Visible text characters in the first viewport. */
  textChars: number;
  /** Page height in viewports. */
  screens: number;
  overflowX: number;
  /** Smallest interactive target, in px, and what it was. */
  minTarget: number; minTargetWhat: string;
}

/** Runs in the page. Everything it needs is declared inside. */
function measure(): Omit<LayoutMetrics, "layout" | "name" | "viewport" | "theme"> {
  const vw = window.innerWidth;
  // The fold is where the sticky transport starts: what sits under it is not visible.
  const vh = Math.min(window.innerHeight, document.querySelector(".lab-transport")?.getBoundingClientRect().top ?? window.innerHeight);
  const scope = document.querySelector(".lab-stage") ?? document.body;
  const alpha = (colour: string): number => {
    const parts = colour.match(/[\d.]+/g);
    if (!parts) return 0;
    return parts.length >= 4 ? Number(parts[3]) : 1;
  };
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (node.classList.contains("sr-only")) return false;
    }
    return true;
  };
  const inFirst = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    return shown(el) && rect.top >= 0 && rect.bottom <= vh + 1 && rect.left >= -1 && rect.right <= vw + 1;
  };

  const fleet = scope.querySelector("[data-loop-fleet]");
  const fleetInFirst = fleet !== null && inFirst(fleet);

  const all = new Set<string>();
  const first = new Set<string>();
  for (const el of scope.querySelectorAll("[data-quest]")) {
    const id = el.getAttribute("data-quest") ?? "";
    if (!shown(el)) continue;
    all.add(id);
    if (inFirst(el)) first.add(id);
  }

  const primaries = [...document.querySelectorAll("[data-primary]")].filter(shown);
  const primary = primaries[0] ?? null;
  const primaryInFirst = primary !== null && inFirst(primary);
  const primaryY = primary ? Math.round(primary.getBoundingClientRect().top + window.scrollY) : null;

  const detail = scope.querySelector("[data-detail] .lp-detail-headline");
  const detailInFirst = detail !== null && inFirst(detail);

  const isBox = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    // Controls are not surfaces: a filled button inside a filled strip is one box, not two.
    if (el.closest("button, a, input, select, textarea, kbd, svg")) return false;
    if (rect.width < 64 || rect.height < 32 || !shown(el)) return false;
    const style = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"].filter((side) => {
      const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const kind = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
      return width > 0 && kind !== "none" && alpha(style.getPropertyValue(`border-${side.toLowerCase()}-color`)) > 0.05;
    }).length;
    const filled = alpha(style.backgroundColor) > 0.05 || style.backgroundImage !== "none";
    const rounded = parseFloat(style.borderTopLeftRadius) > 0;
    return sides >= 3 || (filled && rounded);
  };
  let nestedBoxes = 0;
  const boxes = [...scope.querySelectorAll("*")].filter(isBox);
  const boxSet = new Set(boxes);
  for (const box of boxes) {
    for (let node = box.parentElement; node && node !== scope.parentElement; node = node.parentElement) {
      if (boxSet.has(node)) { nestedBoxes += 1; break; }
    }
  }

  const edges: number[] = [];
  let textChars = 0;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const seenBlocks = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    // A mark placed on the loop encodes where a quest is. Its x is data, not alignment.
    if (!text || !parent || !shown(parent) || parent.closest("[data-plot]")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (!rect || rect.width < 1 || rect.top < 0 || rect.bottom > vh || rect.left < 0 || rect.right > vw + 1) continue;
    textChars += text.length;
    let block: Element = parent;
    while (block.parentElement && getComputedStyle(block).display.startsWith("inline") && block !== scope) block = block.parentElement;
    if (seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    edges.push(Math.round(rect.left));
  }
  edges.sort((a, b) => a - b);
  let leftEdges = 0;
  let last = -Infinity;
  for (const edge of edges) {
    if (edge - last > 2) leftEdges += 1;
    last = edge;
  }

  let minTarget = Infinity;
  let minTargetWhat = "";
  for (const el of scope.querySelectorAll("a[href], button, [role='tab'], input, select, textarea, summary")) {
    if (!shown(el)) continue;
    const rect = el.getBoundingClientRect();
    let width = rect.width;
    let height = rect.height;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (style.content === "none" || style.position !== "absolute") continue;
      width = Math.max(width, parseFloat(style.width) || 0);
      height = Math.max(height, parseFloat(style.height) || 0);
    }
    const size = Math.min(width, height);
    if (size < minTarget) {
      minTarget = size;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      minTargetWhat = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ")[0]}` : ""} "${label}"`;
    }
  }

  return {
    fleetInFirst, questsInFirst: first.size, questsTotal: all.size,
    primaryCount: primaries.length, primaryInFirst, primaryY, detailInFirst,
    glance: Number(fleetInFirst) + Number(primaryInFirst) + Number(detailInFirst),
    nestedBoxes, leftEdges, textChars,
    screens: Math.round((document.documentElement.scrollHeight / window.innerHeight) * 10) / 10,
    overflowX: Math.max(0, document.documentElement.scrollWidth - vw),
    minTarget: Number.isFinite(minTarget) ? Math.round(minTarget) : 0, minTargetWhat,
  };
}

async function settle(page: Page): Promise<void> {
  await page.waitForSelector(".lab-stage > :not(.lab-idea)", { timeout: 15_000 });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(150);
}

if (!args.includes("--no-build")) {
  const build = await $`bun run build:lab`.cwd(root).quiet().nothrow();
  if (build.exitCode !== 0) {
    console.error(build.stderr.toString() || build.stdout.toString());
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const server = serve(join(root, "dist-lab"), "/app/");
const browser = await launch();
const problems: string[] = [];
const metrics: LayoutMetrics[] = [];
const lab = (query: string, hash: string): string => `${server.url}/app/lab.html?${query}#${hash}`;

try {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme, reducedMotion: "reduce",
      });
      const page = await context.newPage();
      let where = "";
      page.on("console", (message) => { if (message.type() === "error") problems.push(`${where}: console: ${message.text()}`); });
      page.on("pageerror", (error) => problems.push(`${where}: ${error.message}`));
      page.on("requestfailed", (request) => problems.push(`${where}: failed ${request.url()}`));
      page.on("response", (response) => { if (response.status() >= 400) problems.push(`${where}: ${response.status()} ${response.url()}`); });

      for (const layout of LAYOUTS) {
        if (only && !only.includes(layout)) continue;
        where = `${layout}@${viewport.name}/${theme}`;
        await page.goto("about:blank");
        await page.goto(lab(`chrome=0&theme=${theme}&motion=reduced`, `/layouts/${layout}`));
        await settle(page);
        const measured = await page.evaluate(measure);
        metrics.push({ layout, name: NAMES[layout] ?? layout, viewport: viewport.name, theme, ...measured });
        if (measured.overflowX > 1) problems.push(`${where}: horizontal overflow ${measured.overflowX}px`);
        if (measured.primaryCount > 1) problems.push(`${where}: ${measured.primaryCount} primary actions, the rule is one`);
        await page.screenshot({ path: join(out, `layout-${layout}-${viewport.name}-${theme}.png`) });
        if (viewport.name === "phone") {
          await page.addStyleTag({ content: ".lab-transport { position: static; }" });
          await page.screenshot({ path: join(out, `layout-${layout}-${viewport.name}-${theme}-full.png`), fullPage: true });
        }
      }

      if (!only) {
        for (const bench of ["components", "alignment", "motion"]) {
          where = `${bench}@${viewport.name}/${theme}`;
          await page.goto("about:blank");
          await page.goto(lab(`theme=${theme}&motion=reduced`, `/${bench}`));
          await settle(page);
          const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (over > 1) problems.push(`${where}: horizontal overflow ${over}px`);
          // A sticky bar lands in the middle of a full-page capture, so it is laid out in the flow for this one shot.
          await page.addStyleTag({ content: ".lab-transport { position: static; }" });
          await page.screenshot({ path: join(out, `bench-${bench}-${viewport.name}-${theme}.png`), fullPage: true });
        }
        for (const tab of ["events", "effects", "attempts", "questions", "runs", "receipts"]) {
          where = `hood-${tab}@${viewport.name}/${theme}`;
          await page.goto("about:blank");
          await page.goto(lab(`theme=${theme}&motion=reduced&hood=1&tab=${tab}&q=T-7f3a2c`, "/layouts/h"));
          await settle(page);
          await page.waitForSelector("[data-inspector]");
          await page.screenshot({ path: join(out, `hood-${tab}-${viewport.name}-${theme}.png`) });
        }
        where = `chrome@${viewport.name}/${theme}`;
        await page.goto("about:blank");
        await page.goto(lab(`theme=${theme}&motion=reduced&grid=1`, "/layouts/h"));
        await settle(page);
        await page.screenshot({ path: join(out, `lab-h-edges-${viewport.name}-${theme}.png`) });
      }
      await context.close();
    }
  }

  if (args.includes("--video")) {
    // One take with motion on: the hour around the hero moment, then the human approves and the quest moves on.
    const dir = join(out, "video");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }, colorScheme: "dark", reducedMotion: "no-preference",
      recordVideo: { dir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    await page.goto(lab("theme=dark&t=84", "/layouts/h"));
    await settle(page);
    await page.keyboard.press("Space");
    await page.waitForTimeout(11_000);
    await page.keyboard.press("Space");
    await page.waitForTimeout(600);
    await page.keyboard.press("a");
    await page.waitForTimeout(900);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_200);
    await page.keyboard.press("Space");
    await page.waitForTimeout(9_000);
    await page.keyboard.press("i");
    await page.waitForTimeout(2_000);
    await context.close();
    const file = readdirSync(dir).find((name) => name.endsWith(".webm"));
    if (file) renameSync(join(dir, file), join(out, "replay-h-dark.webm"));
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  server.stop();
}

writeFileSync(join(out, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);

const cell = (value: unknown, width: number): string => String(value).padEnd(width);
console.log(["layout", "view", "theme", "glance", "quests", "primary", "boxes", "edges", "chars", "screens", "target"]
  .map((head, index) => cell(head, index === 0 ? 18 : 8)).join(""));
for (const row of metrics) {
  console.log([
    cell(`${row.layout} ${row.name}`, 18), cell(row.viewport, 8), cell(row.theme, 8), cell(`${row.glance}/3`, 8),
    cell(`${row.questsInFirst}/${row.questsTotal}`, 8), cell(row.primaryInFirst ? `y${row.primaryY}` : row.primaryCount ? "below" : "none", 8),
    cell(row.nestedBoxes, 8), cell(row.leftEdges, 8), cell(row.textChars, 8), cell(row.screens, 8), cell(row.minTarget, 8),
  ].join(""));
}
console.log(`\n${metrics.length} layout renders measured. Screenshots in ${out}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${[...new Set(problems)].join("\n")}`);
  process.exit(1);
}
