import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupProgress, SetupModeChoice } from "./AutomaticSetup.tsx";
import { SETUP_FIXTURE } from "../fake/setup.ts";

test("recorded blockers stay visible and repository artifact content is escaped", () => {
  const html = renderToStaticMarkup(createElement(SetupProgress, { run: {
    ...SETUP_FIXTURE,
    artifacts: [{ path: "autonomy.md", content: '<script>alert("repository content")</script>', digest: "observed-digest" }],
  } }));
  expect(html).toContain("Setup needs a connection");
  expect(html).toContain("deployment operator");
  expect(html).toContain("observed-digest");
  expect(html).not.toContain("Setup ready");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("supervised mode is an explicit selectable alternative to autonomous setup", () => {
  const html = renderToStaticMarkup(createElement(SetupModeChoice, { value: "autonomous", onChange: () => {} }));
  expect(html).toContain("Self-driving");
  expect(html).toContain("Supervised");
  expect(html.match(/checked=""/g)).toHaveLength(1);
});

test("active investigations remain distinct from ready landing or watch capability", () => {
  const html = renderToStaticMarkup(createElement(SetupProgress, { run: { ...SETUP_FIXTURE, investigationActive: true } }));
  expect(html).toContain("Investigation active · landing needs a connection");
  expect(html).toContain("What can unblock this");
  expect(html).not.toContain("Setup ready");
});
