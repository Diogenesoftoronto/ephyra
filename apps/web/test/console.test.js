import { expect, test } from "bun:test";
import fc from "fast-check";
import { renderConsole } from "../../../site/e/console.js";
import data from "../../../site/e/walkthrough.json";

test("GUI documents retain the cause and every plan instruction", () => {
  const hypothesis = renderConsole("hypothesis", data);
  expect(hypothesis).toContain("rounds each line to whole cents before adding them up");
  expect(hypothesis).toContain("37 failures since 14:02");
  const plan = renderConsole("plan", data);
  expect(plan).toContain("Keep line totals in integer micro-cents");
  expect(plan).toContain("checkout/one-cent-drift");
  expect(plan).toContain("Leave the receipt&#39;s display rounding alone");
});

test("tools expose only the evidence and documents available at the selected moment", () => {
  const triage = renderConsole("triaged", data, { tool: "evidence" });
  expect(triage).toContain("37 events");
  expect(triage).not.toContain("Session that wrote");
  expect(renderConsole("triaged", data, { tool: "files" })).not.toContain("hypothesis.md");
  const filesAtA = renderConsole("hypothesis", data, { tool: "files" });
  expect(filesAtA).toContain("hypothesis.md");
  expect(filesAtA).not.toContain("plan.md");
  expect(filesAtA).not.toContain("total.test.ts");
  expect(renderConsole("plan", data, { tool: "files" })).toContain("plan.md");
  expect(renderConsole("proof", data, { tool: "files" })).toContain("total.test.ts");
  expect(renderConsole("hypothesis", data, { tool: "activity" })).not.toContain("Fix landed");
});

test("proof includes review and failure counts, and missing proof never becomes a pass", () => {
  const proof = renderConsole("proof", data);
  for (const detail of ["412 passed", "6 checked", "1 checked", "3 diffs", "0 unexplained", "31 lines", "No findings"]) {
    expect(proof).toContain(detail);
  }
  const missing = structuredClone(data);
  missing.gui.moments.proof.events = missing.gui.moments.proof.events.filter((e) => e.type !== "proof_completed");
  const html = renderConsole("proof", missing);
  expect(html).toContain("Proof is not available");
  expect(html).not.toContain("412 passed");
});

test("the rollback example retains its own identity and evidence", () => {
  const evidence = renderConsole("rollback", data, { tool: "evidence" });
  expect(evidence).toContain("T-738495");
  expect(evidence).toContain("suggest.ts:91 RangeError");
  expect(evidence).not.toContain("TotalMismatch");
  const activity = renderConsole("rollback", data, { tool: "activity" });
  expect(activity).toContain("Regression detected");
  expect(activity).toContain("Fix reverted");
  expect(renderConsole("rollback", data)).toContain("27 minutes after landing");
});

test("hostile trail and evidence text cannot add markup or attributes", () => {
  const tags = (html) => html.match(/<[^>]+>/g);
  const baseline = tags(renderConsole("explain", data));
  fc.assert(fc.property(fc.string(), (text) => {
    const hostile = `<img src=x onerror="alert(1)">${text}</h3><script>alert(1)</script>`;
    const fixture = structuredClone(data);
    fixture.gui.moments.explain.trail.title = hostile;
    for (const evidence of fixture.gui.evidence) {
      evidence.title = hostile;
      evidence.snippet = hostile;
    }
    expect(tags(renderConsole("explain", fixture))).toEqual(baseline);
  }));
});

test("all tools render every moment, without navigation controls in the full reader", () => {
  for (const { id } of data.steps) {
    for (const tool of ["review", "evidence", "files", "activity"]) {
      const html = renderConsole(id, data, { reader: true, tool });
      expect(html).not.toMatch(/undefined|Invalid Date|NaN/);
      expect(html).not.toContain("data-preview-go");
      expect(html).not.toContain("data-console-tool");
    }
  }
  expect(() => renderConsole("unknown", data)).toThrow("No graphical walkthrough moment");
});
