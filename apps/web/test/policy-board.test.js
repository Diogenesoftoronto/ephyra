// The landing page's policy board (site/e/policy.js): the Map view and the raw file come from one table.
// The site may not import packages/policy, so the product's level table is pinned here as text; it was checked against
// LEVEL_SETTINGS, AUTO_WATCH and renderAutonomy when written. If packages/policy changes the table, change both.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { AUTO_WATCH, LEVELS, SAMPLE, VIEWS, approves, areaLines, lineHtml, renderPolicy, staticBoard, terminalLines } from "../../../site/e/policy.js";

const html = await Bun.file(join(import.meta.dir, "../../../site/e/index.html")).text();
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("the file shown without JavaScript is the one the board writes for its starting selections", () => {
  const pre = /<figure class="file">[\s\S]*?<pre>([\s\S]*?)<\/pre>/.exec(html);
  expect(unescape(pre[1])).toBe(renderPolicy(SAMPLE));
  expect(html).toContain('<script src="policy.js?');
});

test("each level writes the product's settings", () => {
  const settings = (level, risk = "medium") =>
    areaLines({ name: "x", paths: ["src/**"], risk, userFacing: true, level, intent: "" }).slice(4).join(" | ");
  expect(LEVELS.map((l) => l.id)).toEqual(["watch", "research", "propose", "patch", "auto"]);
  expect(settings("watch")).toBe("mode: shadow | checkpoints: A=blocking B=blocking C=blocking | landing: trail_ref");
  expect(settings("research")).toBe("mode: enforce | checkpoints: A=blocking B=blocking C=blocking | landing: trail_ref");
  expect(settings("propose")).toBe("mode: enforce | checkpoints: A=advisory B=blocking C=blocking | landing: trail_ref");
  expect(settings("patch")).toBe("mode: enforce | checkpoints: A=advisory B=advisory C=blocking | landing: trail_ref");
  expect(settings("auto", "low")).toBe("mode: enforce | checkpoints: A=advisory B=advisory C=advisory | landing: trail_ref, auto_land | watch: 1h");
  expect(settings("auto", "medium")).toEndWith("watch: 2h");
  expect(settings("auto", "high")).toEndWith("watch: 4h");
  // Critical areas never auto-land: the top level is written as Patch.
  expect(settings("auto", "critical")).toBe(settings("patch", "critical"));
  expect(AUTO_WATCH).toEqual({ low: "1h", medium: "2h", high: "4h", critical: "4h" });
});

test("an area is written in the product's line order, prose last", () => {
  expect(areaLines(SAMPLE.areas[0])).toEqual([
    "## area: checkout", "paths: services/checkout/**", "risk: medium", "user_facing: true", "mode: enforce",
    "checkpoints: A=blocking B=blocking C=blocking", "landing: trail_ref",
    "Money moves here. A person reads the", "hypothesis and the plan before any code.",
  ]);
});

test("raw lines are escaped", () => {
  expect(lineHtml("paths: <b>", false)).toBe('<span class="md-k">paths:</span> <span class="md-v">&lt;b&gt;</span>');
  expect(lineHtml("a & b", true)).toBe('<span class="md-new"><span class="md-p">a &amp; b</span></span>');
});

test("who decides is said in words, never as checkpoint letters", () => {
  expect(LEVELS.map((l) => approves(l, "2h"))).toEqual([
    "Ephyra only reports here. Nothing is done without you.",
    "You approve the cause, the plan and the landing.",
    "You approve the plan and the landing.",
    "You approve the landing.",
    "Nothing waits for you. Each fix is watched for 2h and rolled back if it regresses.",
  ]);
});

test("the terminal view prints the policy in the CLI's layout and names the command for a change", () => {
  const text = (policy, changed) => terminalLines(policy, changed).map((l) => l.map(([t]) => t).join("")).join("\n");
  expect(VIEWS.map((v) => v.label)).toEqual(["App", "Terminal", "File"]);
  expect(text(SAMPLE, "")).toBe([
    "$ ephyra policy", "",
    "    area      risk      autonomy         paths",
    "    checkout  medium    ●●○○○ Research   services/checkout/**",
    "    docs      low       ●●●●● Auto-land  docs/**, **/*.md", "",
    "  checkout  ● cause ── ● plan ── ● landing",
    "  You approve the cause, the plan and the landing.",
  ].join("\n"));
  const moved = { ...SAMPLE, areas: SAMPLE.areas.map((a) => (a.name === "docs" ? { ...a, level: "patch" } : a)) };
  const after = text(moved, "docs");
  expect(after).toStartWith("$ ephyra policy set docs --level patch\n");
  expect(after).toContain("  ~ docs      low       ●●●●○ Patch      docs/**, **/*.md");
  expect(after).toContain("  docs  ○ cause ── ○ plan ── ● landing\n  You approve the landing.");
});

test("the page ships the board itself, so it reads without a script and the file never shows first", () => {
  // Regenerate the markup in index.html from staticBoard() after changing the sample policy or the board's markup.
  expect(html).toContain(staticBoard());
  const board = html.indexOf('<div class="pb-map">'), file = html.indexOf('<details class="pb-raw">');
  expect(board).toBeGreaterThan(0);
  expect(file).toBeGreaterThan(board);
  expect(html.slice(file, html.indexOf("</details>", file))).toContain("## area: checkout");
  // The shipped board states who decides in words, with nothing left for a script to fill in.
  expect(staticBoard()).toContain('<span class="pb-level-name">Research</span>');
  expect(staticBoard()).toContain("You approve the cause, the plan and the landing.");
  expect(staticBoard()).not.toMatch(/<span class="pb-(level-name|you)"[^>]*><\/span>/);
  // Checkpoints are named by what is decided. The letters appear only in the file's own syntax.
  expect(html).not.toContain('class="gates"');
  expect(html).not.toMatch(/checkpoint [ABC]\b/);
});
