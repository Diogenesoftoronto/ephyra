import { expect, test } from "bun:test";
import { FakeApi } from "../fake/api.ts";
import { RUN_IDS } from "../fake/runs.ts";
import { demoRunVisual } from "../fake/run-visual.ts";
import { runLink, runPresentations } from "./run-presentations.ts";

test("visual revisions are ordered, run-bound and replay-idempotent without touching their content", async () => {
  const run = await new FakeApi().run(RUN_IDS.orb);
  const first = { runId: run.id, seq: 2, at: run.startedAt, type: "message" as const, visual: demoRunVisual };
  const next = { ...first, seq: 8, visual: { ...demoRunVisual, html: "<p>newer</p>" } };
  const foreign = { ...first, runId: "another-run", seq: 99 };
  const result = runPresentations(run, [next, foreign, first, next]);
  expect(result.visuals).toHaveLength(1);
  expect(result.visuals[0]?.visual.html).toBe("<p>newer</p>");
  expect(result.visuals[0]?.seq).toBe(8);
});

test("only recorded http(s) access without embedded credentials becomes a run link", () => {
  for (const value of [undefined, "javascript:alert(1)", "file:///etc/passwd", "https://user:secret@host.test/", "/app/", "not a URL"]) {
    expect(runLink(value)).toBeUndefined();
  }
  expect(runLink("https://ampcode.com/threads/T-123")).toBe("https://ampcode.com/threads/T-123");
});
