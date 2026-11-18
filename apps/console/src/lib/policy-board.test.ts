import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AUTONOMY_LEVELS, type AreaSketch } from "@ephyra/core";
import {
  areaNameError, blockingDraft, boardCounts, boardSummary, changesLabel, levelStep, meterLabel, parsePaths,
  pathSummary, pendingChanges, reusableDraft, riskTone, untouchedDraft,
} from "./policy-board.ts";

const level = fc.constantFrom(...AUTONOMY_LEVELS.map((l) => l.id));
const risk = fc.constantFrom("low", "medium", "high", "critical") as fc.Arbitrary<AreaSketch["risk"]>;
const sketch = (name: string): fc.Arbitrary<AreaSketch> =>
  fc.record({
    name: fc.constant(name), intent: fc.string({ maxLength: 20 }),
    paths: fc.array(fc.constantFrom("src/a/**", "src/b/**", "docs/**"), { maxLength: 3 }),
    risk, level, userFacing: fc.boolean(),
  });
const sketches = fc.uniqueArray(fc.constantFrom("cart", "payments", "search", "docs", "auth", "site"), { maxLength: 6 })
  .chain((names) => (names.length ? fc.tuple(...names.map(sketch)) : fc.constant([] as AreaSketch[])));

const area = (patch: Partial<AreaSketch> = {}): AreaSketch => ({
  name: "cart", intent: "", paths: [], risk: "medium", level: "research", userFacing: false, ...patch,
});

describe("policy board", () => {
  test("the meter fills one pip per level, in ladder order", () => {
    expect(AUTONOMY_LEVELS.map((l) => levelStep(l.id))).toEqual([1, 2, 3, 4, 5]);
    expect(meterLabel("watch")).toBe("Autonomy: Watch, 1 of 5");
    expect(meterLabel("patch")).toBe("Autonomy: Patch, 4 of 5");
    expect(meterLabel("auto")).toBe("Autonomy: Auto-land, 5 of 5");
  });

  test("critical is bad, high is a warning, the rest are neutral", () => {
    expect((["low", "medium", "high", "critical"] as const).map(riskTone)).toEqual(["neutral", "neutral", "warn", "bad"]);
  });

  test("the row shows the first path and counts the others", () => {
    expect(pathSummary([])).toEqual({ first: null, more: 0 });
    expect(pathSummary(["src/cart/**"])).toEqual({ first: "src/cart/**", more: 0 });
    expect(pathSummary(["a", "b", "c"])).toEqual({ first: "a", more: 2 });
    expect(parsePaths(" src/a/** , ,src/b/**,")).toEqual(["src/a/**", "src/b/**"]);
  });

  test("area names", () => {
    expect(areaNameError("", [])).toBeNull();
    expect(areaNameError("billing", ["cart"])).toBeNull();
    expect(areaNameError("Billing", [])).toBe("Lowercase letters, numbers and dashes.");
    expect(areaNameError("-x", [])).toBe("Lowercase letters, numbers and dashes.");
    expect(areaNameError("a".repeat(61), [])).toBe("Lowercase letters, numbers and dashes.");
    expect(areaNameError("cart", ["cart"])).toBe("That area already exists.");
  });

  test("the summary counts only what the sketches say", () => {
    expect(boardSummary([])).toBe("0 areas");
    expect(boardSummary([area()])).toBe("1 area");
    expect(boardSummary([area({ level: "auto" }), area({ name: "pay", risk: "critical" })]))
      .toBe("2 areas · 1 lands by itself · 1 critical");
    expect(boardSummary([area({ level: "auto" }), area({ name: "b", level: "auto", risk: "critical" })]))
      .toBe("2 areas · 2 land by themselves · 1 critical");
    fc.assert(fc.property(sketches, (list) => {
      const c = boardCounts(list);
      expect(c.areas).toBe(list.length);
      expect(c.auto).toBe(list.filter((s) => s.level === "auto").length);
      expect(c.critical).toBe(list.filter((s) => s.risk === "critical").length);
      expect(c.auto).toBeLessThanOrEqual(c.areas);
      expect(boardSummary(list).startsWith(`${list.length} area`)).toBe(true);
    }));
  });

  test("an untouched or absent working copy has no pending changes", () => {
    fc.assert(fc.property(sketches, (list) => {
      expect(pendingChanges(list, null)).toBe(0);
      expect(pendingChanges(list, structuredClone(list))).toBe(0);
    }));
  });

  test("pending changes count areas added, removed and changed", () => {
    const published = [area(), area({ name: "pay", risk: "critical" }), area({ name: "docs" })];
    const working = [area({ level: "patch" }), area({ name: "pay", risk: "critical" }), area({ name: "billing" })];
    expect(pendingChanges(published, working)).toBe(3);
    expect(changesLabel(1)).toBe("1 change");
    expect(changesLabel(3)).toBe("3 changes");
    fc.assert(fc.property(sketches, level, (list, next) => {
      fc.pre(list.length > 0);
      const moved = list.map((s, i) => (i === 0 ? { ...s, level: next } : s));
      expect(pendingChanges(list, moved)).toBe(next === list[0]!.level ? 0 : 1);
      expect(pendingChanges(list, list.slice(1))).toBe(1);
    }));
  });

  test("only a draft nobody worked in may be reused; any other open draft blocks inline edits", () => {
    const doc = { content: "# autonomy", digest: "d1" };
    const draft = { id: "d-1", path: "autonomy.md", status: "open", content: doc.content, baseDigest: doc.digest, messages: [] as unknown[] };
    expect(untouchedDraft(draft, doc)).toBe(true);
    expect(reusableDraft([draft], "autonomy.md", doc)?.id).toBe("d-1");
    expect(blockingDraft([draft], "autonomy.md", doc)).toBeNull();
    for (const worked of [
      { ...draft, content: "# autonomy\nedited" },
      { ...draft, baseDigest: "d0" },
      { ...draft, messages: [{}] },
    ]) {
      expect(untouchedDraft(worked, doc)).toBe(false);
      expect(blockingDraft([worked], "autonomy.md", doc)?.id).toBe("d-1");
      expect(reusableDraft([worked], "autonomy.md", doc)).toBeNull();
    }
    for (const closed of ["published", "discarded"]) {
      expect(blockingDraft([{ ...draft, status: closed, content: "x" }], "autonomy.md", doc)).toBeNull();
      expect(reusableDraft([{ ...draft, status: closed }], "autonomy.md", doc)).toBeNull();
    }
    expect(blockingDraft([{ ...draft, path: "thresholds.yaml", content: "x" }], "autonomy.md", doc)).toBeNull();
  });
});
