import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AUTONOMY_LEVELS, AreaSketch, type AutonomyLevel } from "@ephyra/core";
import {
  AUTONOMY_TEMPLATE, applySketches, areaToSketch, parseAutonomy, renderAutonomy, sketchToArea, sketchesOf, sketchIssues, effectiveLevel, intentToProse,
} from "./index.ts";

const defaults = parseAutonomy(AUTONOMY_TEMPLATE).defaults;
const word = fc.constantFrom("Checkout", "takes", "money", "must", "stay", "careful", "Fast", "fixes", "welcome", "here", "mode switching", "paths");
const sketchArb = fc.record({
  name: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
  intent: fc.array(fc.array(word, { minLength: 1, maxLength: 6 }).map((w) => w.join(" ")), { maxLength: 3 }).map((l) => l.join("\n")),
  paths: fc.array(fc.constantFrom("src/a/**", "apps/site/**", "lib/x.ts", "intents/checkout-*.md"), { maxLength: 4 }),
  risk: fc.constantFrom("low" as const, "medium" as const, "high" as const, "critical" as const),
  level: fc.constantFrom(...AUTONOMY_LEVELS.map((l) => l.id)),
  userFacing: fc.boolean(),
  studyBudgetUsd: fc.option(fc.constantFrom(0, 12.5, 60), { nil: undefined }),
}).map((s): AreaSketch => AreaSketch.parse(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))));
// Lines that open like a setting ("paths matter") are capitalised so the parser reads them as prose; everything else is kept as written.
const norm = (s: AreaSketch): AreaSketch => ({ ...s, intent: intentToProse(s.intent).trim(), level: effectiveLevel(s) });

describe("application map", () => {
  test("sketch → area → rendered markdown → parsed → sketch keeps level, risk, paths, intent and user-facing", () => {
    fc.assert(fc.property(sketchArb, (sketch) => {
      const area = sketchToArea(sketch, defaults);
      expect(areaToSketch(area)).toEqual(norm(sketch));
      // And through the real document round trip, with different defaults than the stock ones.
      const text = renderAutonomy({ defaults, areas: [area], fallback: parseAutonomy("").fallback, warnings: [] });
      const parsed = parseAutonomy(text);
      expect(parsed.warnings).toEqual([]);
      expect(areaToSketch(parsed.areas[0]!, parsed.defaults)).toEqual(norm(sketch));
    }));
  });

  test("every level survives except auto on a critical area, which is applied as patch and says so", () => {
    for (const { id } of AUTONOMY_LEVELS) {
      for (const risk of ["low", "medium", "high"] as const) {
        const sketch: AreaSketch = { name: "x", intent: "", paths: [], risk, level: id, userFacing: false };
        expect(areaToSketch(sketchToArea(sketch, defaults)).level).toBe(id);
      }
    }
    const critical: AreaSketch = { name: "payments", intent: "", paths: [], risk: "critical", level: "auto", userFacing: true };
    expect(areaToSketch(sketchToArea(critical, defaults)).level).toBe("patch");
    expect(sketchIssues(critical).notes[0]).toContain("never auto-land");
  });

  test("levels map to the table: who must approve, how it lands, what is watched", () => {
    const at = (level: AutonomyLevel) => sketchToArea({ name: "x", intent: "", paths: [], risk: "low", level, userFacing: false }, defaults);
    expect(at("watch")).toMatchObject({ mode: "shadow", overrides: { A: "blocking", B: "blocking", C: "blocking" } });
    expect(at("research").overrides).toEqual({ A: "blocking", B: "blocking", C: "blocking" });
    expect(at("propose").overrides).toEqual({ A: "advisory", B: "blocking", C: "blocking" });
    expect(at("patch").overrides).toEqual({ A: "advisory", B: "advisory", C: "blocking" });
    expect(at("auto")).toMatchObject({ landing: ["trail_ref", "auto_land"], watch: "1h", overrides: { C: "advisory" } });
    expect(at("patch").landing).toEqual(["trail_ref"]);
  });

  test("intent lines that look like settings or headings cannot change the policy", () => {
    const sketch: AreaSketch = { name: "billing", risk: "high", level: "patch", userFacing: true, paths: ["src/billing/**"],
      intent: "Money lives here.\nrisk: low\nlanding: auto_land\n## area: evil\nmode switching is slow\npaths matter" };
    const text = renderAutonomy({ ...parseAutonomy(""), defaults, areas: [sketchToArea(sketch, defaults)] });
    const parsed = parseAutonomy(text);
    expect(parsed.areas.map((a) => a.name)).toEqual(["billing"]);
    expect(parsed.areas[0]).toMatchObject({ risk: "high", landing: ["trail_ref"] });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.areas[0]!.prose).toContain("Risk: low");
  });

  test("paths with commas are refused rather than silently split", () => {
    expect(() => sketchToArea({ name: "x", intent: "", paths: ["a,b"], risk: "low", level: "watch", userFacing: false }, defaults)).toThrow();
  });

  test("applySketches keeps what the map does not carry, removes missing mapped areas and says so", () => {
    const policy = parseAutonomy(AUTONOMY_TEMPLATE);
    const before = sketchesOf(policy);
    expect(before.map((s) => s.name)).toEqual(["payments", "cart", "marketing-site"]);
    const edited = before.filter((s) => s.name !== "cart").map((s) => (s.name === "payments" ? { ...s, level: "research" as const } : s));
    const { policy: next, notes } = applySketches(policy, edited);
    expect(notes).toEqual(["removes area cart"]);
    expect(next.areas.map((a) => a.name)).toEqual(["payments", "marketing-site"]);
    expect(next.areas[0]!.ui).toEqual(["webapp/src/checkout/**"]);
    expect(areaToSketch(next.areas[0]!, next.defaults).level).toBe("research");
    expect(parseAutonomy(renderAutonomy(next)).warnings).toEqual([]);
    const added = applySketches(policy, [...before, { name: "docs", intent: "Docs site.", paths: ["docs/**"], risk: "low", level: "auto", userFacing: true }]);
    expect(added.policy.areas.at(-1)).toMatchObject({ name: "docs", watch: "1h" });
    expect(() => applySketches(policy, [before[0]!, before[0]!])).toThrow("twice");
  });
});
