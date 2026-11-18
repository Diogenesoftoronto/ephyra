import { expect, test } from "bun:test";
import fc from "fast-check";
import { briefCount, briefKind, briefPaths, readBrief, type DocumentBrief } from "../src/brief.ts";

const HYPOTHESIS = `# Hypothesis
\`sumLineItems\` rounds each line to whole cents before adding them up, so a cart of discounted lines
can total a cent less than the amount charged.

## Evidence
- 37 failures since 14:02, every one a cart with three or more discounted lines
- Started with 8c1e0f2, "show per-line discounts"
- No earlier quest touched total.ts

## Next
Reproduce with three lines at 33⅓% off, then round once, at the end.`;

const PLAN = `# Plan
1. Keep line totals in integer micro-cents; round once, in \`cartTotal\`.
2. Add the probe \`checkout/one-cent-drift\`; it fails on base.
3. Leave the receipt's display rounding alone.

Touches: services/checkout/src/total.ts, total.test.ts
Not touching: the payments adapter.`;

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const said = (brief: DocumentBrief) => words([brief.title ?? "",
  ...brief.parts.flatMap((p) => [p.named ? p.label : "", ...p.blocks.map((b) => b.type === "item" ? `${b.marker} ${b.text}` : b.text)])].join("\n"));

test("a hypothesis reads as its cause, its evidence and what comes next", () => {
  const brief = readBrief(HYPOTHESIS, "hypothesis.md");
  expect(brief.title).toBe("Hypothesis");
  expect(brief.parts.map((p) => [p.label, p.kind, p.named])).toEqual([
    ["Cause", "claim", false], ["Evidence", "evidence", true], ["Next", "check", true]]);
  expect(brief.parts[0]!.blocks).toEqual([{ type: "text", text: "`sumLineItems` rounds each line to whole cents before adding them up, "
    + "so a cart of discounted lines can total a cent less than the amount charged." }]);
  expect(briefCount(brief.parts[1]!)).toBe(3);
  expect(brief.parts[1]!.blocks[1]).toEqual({ type: "item", text: 'Started with 8c1e0f2, "show per-line discounts"', marker: "•", depth: 0 });
});

test("a plan reads as numbered steps and the files it names", () => {
  const brief = readBrief(PLAN, "trails/T-1/plan.md");
  expect(brief.parts.map((p) => [p.label, p.kind, p.named])).toEqual([
    ["Steps", "steps", false], ["Touches", "scope", true], ["Not touching", "scope", true]]);
  expect(brief.parts[0]!.blocks.map((b) => b.type === "item" && b.marker)).toEqual(["1.", "2.", "3."]);
  expect(briefPaths(brief.parts[1]!)).toEqual(["services/checkout/src/total.ts", "total.test.ts"]);
  expect(briefPaths(brief.parts[2]!)).toBeNull();
});

test("a one-line document is its opening part, and an empty one has no parts", () => {
  expect(readBrief("Guard the empty cart in total().", "plan.md").parts).toEqual([
    { label: "Approach", kind: "steps", named: false, blocks: [{ type: "text", text: "Guard the empty cart in total()." }] }]);
  expect(readBrief("find() calls includes() on a null item.\n", "hypothesis.md").parts[0]!.label).toBe("Cause");
  expect(readBrief(" \n\n", "plan.md")).toEqual({ parts: [] });
  expect(readBrief("notes", "notes.md").parts[0]!.label).toBe("Summary");
});

test("code fences, nested items and text after a key line stay where the document put them", () => {
  const brief = readBrief(["## Risks", "- Rounding moves", "  - only for discounts", "", "Verification: run the probe",
    "", "A closing remark.", "", "```sh", "bun test  # Not: a key", "```"].join("\n"), "plan.md");
  expect(brief.title).toBeUndefined();
  expect(brief.parts.map((p) => [p.label, p.kind, p.named])).toEqual([
    ["Risks", "risk", true], ["Verification", "check", true], ["Also", "other", false]]);
  expect(brief.parts[0]!.blocks[1]).toEqual({ type: "item", text: "only for discounts", marker: "•", depth: 1 });
  expect(brief.parts[2]!.blocks).toEqual([{ type: "text", text: "A closing remark." }, { type: "code", text: "bun test  # Not: a key" }]);
});

test("labels suggest a kind and unknown labels stay neutral", () => {
  expect(briefKind("Competing causes")).toBe("doubt");
  expect(briefKind("Uncertainty")).toBe("doubt");
  expect(briefKind("Verification")).toBe("check");
  expect(briefKind("Implementation steps")).toBe("steps");
  expect(briefKind("Background")).toBe("other");
});

const line = fc.oneof(
  fc.constantFrom("", "", "## Evidence", "# Plan", "### Open questions", "```", "Touches: a/b.ts, c.ts", "Risk: none known"),
  fc.tuple(fc.constantFrom("", "- ", "1. ", "  - ", "12) ", "Note: "), fc.stringMatching(/^[a-z0-9 .,]{1,40}$/)).map(([lead, text]) => lead + text),
);

test("property: every word of the document is in the reading, in order", () => {
  fc.assert(fc.property(fc.array(line, { maxLength: 30 }), fc.constantFrom("hypothesis.md", "plan.md", "other.md"), (lines, path) => {
    const source = lines.join("\n");
    expect(said(readBrief(source, path))).toEqual(words(source));
  }));
});
