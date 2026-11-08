import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeSource } from "./KnowledgeConnections.tsx";
import { eligibleKnowledgeTool, knowledgeLink, unavailableSelection } from "./knowledge-selection.ts";
import { KNOWLEDGE_CATALOG_FIXTURE, KNOWLEDGE_SELECTION_FIXTURE } from "../fake/knowledge.ts";

const source = KNOWLEDGE_CATALOG_FIXTURE.sources[0]!;
const saved = KNOWLEDGE_SELECTION_FIXTURE[0]!;

test("same-name tools cannot inherit permission after definition or query-shape changes", () => {
  expect(unavailableSelection(saved, source)).toBeNull();
  for (const tool of [
    { ...source.tools[0]!, definitionHash: "e".repeat(64) },
    { ...source.tools[0]!, queryField: "different" },
    { ...source.tools[0]!, queryField: null, unavailableReason: "Writes data" },
  ]) expect(unavailableSelection(saved, { ...source, tools: [tool] })).not.toBeNull();
  expect(unavailableSelection(saved, undefined)).not.toBeNull();
  expect(unavailableSelection(saved, { ...source, resourcesAllowed: false })).not.toBeNull();
});

test("unsupported tools remain inspectable but cannot be selected", () => {
  const issues = KNOWLEDGE_CATALOG_FIXTURE.sources[1]!;
  const html = renderToStaticMarkup(createElement(KnowledgeSource, { source: issues, onChange: () => {} }));
  expect(eligibleKnowledgeTool(issues.tools[1]!)).toBeFalse();
  expect(html).toContain("create_issue");
  expect(html).toContain("Unavailable");
  expect(html).not.toMatch(/<option[^>]*>create_issue<\/option>/);
  expect(html).toMatch(/<option value="" selected="">No search tool<\/option>/);
});

test("revoked and changed saved choices are rendered explicitly, without selecting a replacement", () => {
  const html = renderToStaticMarkup(createElement(KnowledgeSource, {
    source: { ...source, tools: [{ ...source.tools[0]!, definitionHash: "e".repeat(64) }] }, selection: saved, onChange: () => {},
  }));
  expect(html).toContain("The saved search tool changed or is unavailable");
  expect(html).toMatch(/<option value="unavailable" disabled="" selected="">/);
  expect(html).toContain("Remove saved source");
});

test("source text is escaped and portal links cannot execute script or leak URL credentials", () => {
  const html = renderToStaticMarkup(createElement(KnowledgeSource, {
    source: { ...source, label: "<img src=x onerror=alert(1)>" }, onChange: () => {},
  }));
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  for (const value of ["javascript:alert(1)", "//evil.example/path", "/\\evil.example", "https://secret@portal.example", "data:text/html,x", "http://portal.example", "http://127.0.0.1.evil.example", "http://secret@localhost:8080"]) {
    expect(knowledgeLink(value)).toBeNull();
  }
  expect(knowledgeLink("/auth/login?setup=1")).toBe("/auth/login?setup=1");
  expect(knowledgeLink("https://portal.example/connections?app=ephyra")).toBe("https://portal.example/connections?app=ephyra");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(knowledgeLink(`http://${host}:8080/connections?app=ephyra`)).toBe(`http://${host}:8080/connections?app=ephyra`);
  }
});
