import { expect, test } from "bun:test";
import fc from "fast-check";
import { AgentRunEvent, RunVisual } from "../src/index.ts";

test("old events stay valid; a visual carries content without granting a proof or action", () => {
  const event = { runId: "r", seq: 0, at: "2026-11-08T01:00:00.000Z", type: "message", text: "hello" };
  expect(AgentRunEvent.parse(event).visual).toBeUndefined();
  expect(AgentRunEvent.parse({ ...event, visual: { id: "v", title: "Inspect", html: "<p>Hello</p>" } }).visual?.height).toBe(420);
  expect(RunVisual.safeParse({ id: "../outside", title: "x", html: "x" }).success).toBe(false);
  expect(RunVisual.safeParse({ id: "v", title: "x", html: "x".repeat(240001) }).success).toBe(false);
  expect(RunVisual.safeParse({ id: "v", title: "x", html: "x", height: Infinity }).success).toBe(false);
});

test("valid presentation content round trips exactly and stays bounded when serialized", () => {
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 5000 }), fc.integer({ min: 160, max: 1200 }), (html, height) => {
    const visual = RunVisual.parse({ id: "visual-1", title: "Inspect", html, height });
    expect(RunVisual.parse(JSON.parse(JSON.stringify(visual)))).toEqual(visual);
    expect(visual.html).toBe(html);
    expect(JSON.stringify(visual).length).toBeLessThanOrEqual(256000);
  }));
});
