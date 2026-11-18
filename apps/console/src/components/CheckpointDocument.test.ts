import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckpointDocument, readsAsBrief } from "./CheckpointDocument.tsx";
import { HYPOTHESIS, PLAN } from "../fake/documents.ts";

const render = (path: string, content: string) =>
  renderToStaticMarkup(createElement(CheckpointDocument, { path, content }));

test("a hypothesis opens as labelled parts in the document's order, with the file one press away", () => {
  const html = render("hypothesis.md", HYPOTHESIS);
  const labels = [...html.matchAll(/<dt>([^<]+)/g)].map((m) => m[1]);
  expect(labels).toEqual(["Cause", "Evidence", "Competing causes", "Next"]);
  expect(html).toContain("<code>sumLineItems</code> rounds each line");
  expect(html).toContain('aria-label="3 items"');
  expect(html).toContain('aria-pressed="true">Brief</button>');
  expect(html).toContain('aria-pressed="false">File</button>');
  // The brief replaces the raw file until File is chosen.
  expect(html).not.toContain("review-document");
  expect(html).not.toContain("## Evidence");
});

test("a plan shows its steps with their own numbers and the files it names", () => {
  const html = render("trails/T-91be04/plan.md", PLAN);
  expect([...html.matchAll(/<dt>([^<]+)/g)].map((m) => m[1])).toEqual(["Steps", "Touches", "Not touching", "Risks", "Verification"]);
  expect(html).toContain('<span class="cd-marker" aria-hidden="false">2.</span>');
  expect(html).toContain("<li><code>services/checkout/src/total.ts</code></li><li><code>total.test.ts</code></li>");
  expect(html).toContain('<pre class="cd-code">bun test services/checkout</pre>');
});

test("agent text is escaped, an empty document stays a file, and other documents are not read as briefs", () => {
  const html = render("hypothesis.md", "## Evidence\n- <img src=x onerror=alert(1)> `<script>`");
  expect(html).not.toContain("<img");
  expect(html).toContain("<code>&lt;script&gt;</code>");
  const empty = render("plan.md", "\n");
  expect(empty).toContain("review-document");
  expect(empty).not.toContain("cd-switch");
  expect(readsAsBrief("hypothesis.md") && readsAsBrief("trails/T-1/plan.md")).toBe(true);
  expect(readsAsBrief("intent.md") || readsAsBrief("evidence/index.json") || readsAsBrief("replan.md")).toBe(false);
});

test("a long part opens with its first items and says how many more there are", () => {
  const html = render("hypothesis.md", `## Evidence\n${Array.from({ length: 9 }, (_, i) => `- item ${i + 1}`).join("\n")}`);
  expect(html).toContain("item 4");
  expect(html).not.toContain("item 5");
  expect(html).toContain("Show 5 more");
});
