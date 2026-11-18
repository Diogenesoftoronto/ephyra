import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AUTONOMY_LEVELS, AreaSketch, type AutonomyLevel } from "@ephyra/core";
import {
  AUTONOMY_TEMPLATE, applySketches, areaToSketch, parseAutonomy, renderAutonomy, sketchToArea, sketchesOf, sketchIssues, effectiveLevel, intentToProse, levelOf,
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

  test("an area whose level did not change keeps its own settings; only the edited area is rewritten", () => {
    const policy = parseAutonomy([
      "## defaults", "mode: enforce", "checkpoints: A=advisory B=advisory C=advisory", "landing: trail_ref", "watch: 2h", "",
      "## area: server", "paths: apps/server/**", "risk: high", "user_facing: true", "landing: pull_request", "watch: 6h", "A named human approves C.", "",
      "## area: site", "paths: site/**", "risk: low", "user_facing: true", "landing: auto_land", "watch: 1h", "The public site.", "",
    ].join("\n"));
    const before = sketchesOf(policy);
    const same = applySketches(policy, before);
    expect(same.notes).toEqual([]);
    expect(same.policy.areas).toEqual(policy.areas);
    // Moving site down the ladder rewrites site and leaves server's pull_request landing and 6h watch alone.
    const edited = before.map((s) => (s.name === "site" ? { ...s, level: "propose" as const } : s));
    const { policy: next } = applySketches(policy, edited);
    expect(next.areas[0]).toEqual(policy.areas[0]!);
    expect(next.areas[1]).toMatchObject({ landing: ["trail_ref"], overrides: { A: "advisory", B: "blocking", C: "blocking" } });
    // Editing risk, paths or intent at the same level keeps the settings and replaces only those fields.
    const api = { risk: "medium" as const, paths: ["apps/api/**"], intent: "The API." };
    const moved = applySketches(policy, before.map((s) => (s.name === "server" ? { ...s, ...api } : s)));
    expect(moved.policy.areas[0]).toMatchObject({ risk: "medium", paths: ["apps/api/**"], prose: "The API.\n", landing: ["pull_request"], watch: "6h" });
    // An auto-landing area that becomes critical is still brought down to Patch, and the note says so.
    const critical = applySketches(policy, before.map((s) => (s.name === "site" ? { ...s, risk: "critical" as const } : s)));
    expect(critical.notes[0]).toContain("never auto-land");
    expect(levelOf(critical.policy.areas[1]!, critical.policy.defaults)).toBe("patch");
  });

  test("applySketches is the identity on any policy the map can read", () => {
    fc.assert(fc.property(fc.uniqueArray(sketchArb, { selector: (s) => s.name, maxLength: 4 }), (list) => {
      const policy = { ...parseAutonomy(""), defaults, areas: list.map((s) => sketchToArea(s, defaults)) };
      expect(applySketches(policy, sketchesOf(policy)).policy.areas).toEqual(policy.areas);
    }));
  });

  test("the title and introduction above the first heading survive a map edit", () => {
    const text = "# Autonomy policy\n\nOur policy, in our words.\n\n## defaults\nmode: enforce\n\n"
      + "## area: site\npaths: site/**\nrisk: low\nuser_facing: true\nThe site.\n";
    const policy = parseAutonomy(text);
    expect(policy.preamble).toBe("# Autonomy policy\n\nOur policy, in our words.\n\n");
    const { policy: next } = applySketches(policy, sketchesOf(policy).map((s) => ({ ...s, level: "patch" as const })));
    const rendered = renderAutonomy(next);
    expect(rendered).toStartWith("# Autonomy policy\n\nOur policy, in our words.\n");
    expect(parseAutonomy(rendered)).toEqual({ ...next, warnings: [] });
    expect(parseAutonomy(renderAutonomy(parseAutonomy("## defaults\nmode: shadow\n"))).preamble).toBeUndefined();
  });
});
