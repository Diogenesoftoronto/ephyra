import { expect, test } from "bun:test";
import { readBrief as coreBrief } from "../../../packages/core/src/brief.ts";
import { briefHtml, readBrief } from "../../../site/e/brief.js";
import { renderConsole } from "../../../site/e/console.js";
import data from "../../../site/e/walkthrough.json";

const DOCUMENTS = [
  ["hypothesis.md", data.gui.hypothesis],
  ["plan.md", data.gui.plan],
  ["plan.md", "Guard the empty cart in total()."],
  ["hypothesis.md", "## Evidence\n- one\n  - nested\n\nRisk: none known\n\nA closing remark.\n\n```sh\nbun test\n```\n"],
  ["plan.md", "# Plan\n\nIntro text\nwrapped.\n\n### Open questions\n1) first\n2) second\nNot touching: a/b.ts, c.ts\n"],
  ["notes.md", ""],
];

test("the landing page reads a checkpoint document exactly as the app and the CLI do", () => {
  for (const [path, text] of DOCUMENTS) expect(readBrief(text, path)).toEqual(coreBrief(text, path));
});

test("the sample hypothesis and plan are shown as labelled parts, not as the raw file", () => {
  const hypothesis = renderConsole("hypothesis", data);
  expect([...hypothesis.matchAll(/<dt>([^<]+)/g)].map((m) => m[1])).toEqual(["Cause", "Evidence", "Next"]);
  expect(hypothesis).toContain("<code>sumLineItems</code> rounds each line");
  expect(hypothesis).toContain("<dt>Evidence<span>3</span></dt>");
  const plan = renderConsole("plan", data);
  expect([...plan.matchAll(/<dt>([^<]+)/g)].map((m) => m[1])).toEqual(["Steps", "Touches", "Not touching"]);
  expect(plan).toContain('<p class="g-brief-item"><span>2.</span>');
  // The file itself stays one step away, under Files.
  expect(renderConsole("plan", data, { tool: "files" })).toContain("plan.md");
});

test("document text cannot become markup", () => {
  const html = briefHtml("## <b>Evidence</b>\n- <img src=x onerror=alert(1)> `<script>`\n\n```\n</pre><script>\n```", "hypothesis.md");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<b>");
  expect(html).toContain("<code>&lt;script&gt;</code>");
  expect(briefHtml(" ", "plan.md")).toContain("g-file-text");
});
