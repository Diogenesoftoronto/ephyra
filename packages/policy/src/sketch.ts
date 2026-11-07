// The application map: AreaSketch (plain-language area + a level on a five-step ladder) <-> the parsed autonomy Area.
// design/05-console.md "The application map". The level table lives in README.md; keep them in step.
import type { AreaSketch, AutonomyLevel, Checkpoint, LandingMode } from "@ephyra/core";
import { type Area, type AutonomyPolicy } from "./autonomy";

type Defaults = AutonomyPolicy["defaults"];
type Mode = "advisory" | "blocking";

/** What each level means in the settings the parser reads. `mode` shadow = the policy observes and a human still decides everything. */
export const LEVEL_SETTINGS: Record<AutonomyLevel, { mode: "shadow" | "enforce"; checkpoints: Record<Checkpoint, Mode>; landing: LandingMode[] }> = {
  watch: { mode: "shadow", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"] },
  research: { mode: "enforce", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"] },
  propose: { mode: "enforce", checkpoints: { A: "advisory", B: "blocking", C: "blocking" }, landing: ["trail_ref"] },
  patch: { mode: "enforce", checkpoints: { A: "advisory", B: "advisory", C: "blocking" }, landing: ["trail_ref"] },
  auto: { mode: "enforce", checkpoints: { A: "advisory", B: "advisory", C: "advisory" }, landing: ["trail_ref", "auto_land"] },
};
/** Watch window after an auto-landed change: the riskier the area, the longer Ephyra watches. */
export const AUTO_WATCH: Record<AreaSketch["risk"], string> = { low: "1h", medium: "2h", high: "4h", critical: "4h" };

/** Critical areas never auto-land (`autoLandAllowed`), so a critical sketch at the top level is applied as Patch. */
export function effectiveLevel(sketch: Pick<AreaSketch, "level" | "risk">): AutonomyLevel {
  return sketch.level === "auto" && sketch.risk === "critical" ? "patch" : sketch.level;
}

/** Problems that make a sketch unrenderable (errors) or that change its meaning (notes). */
export function sketchIssues(sketch: AreaSketch): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  for (const p of sketch.paths) if (!p.trim() || /[,\r\n]/.test(p)) errors.push(`${sketch.name}: path "${p.slice(0, 40)}" is empty or contains a comma or newline`);
  if (sketch.level !== effectiveLevel(sketch)) notes.push(`${sketch.name}: critical areas never auto-land, so the level is applied as Patch`);
  return { errors, notes };
}

const KEYWORD_LINE = /^(\s*)(mode|checkpoints|landing|watch|decide|paths|ui|risk|user_facing|voxq_budget_usd)(\s*(?:=|:|\s))/;
/**
 * The intent becomes the area's prose, which the parser reads line by line: a line that starts like a setting would be taken as one
 * (or rejected), and a "## " line would end the area. Such lines are rewritten (first letter capitalised, heading marks reduced), not dropped.
 */
export function intentToProse(intent: string): string {
  const lines = intent.trim().split(/\r?\n/).map((line) => {
    const heading = line.replace(/^(\s*)#{2,}(\s)/, "$1#$2");
    return heading.replace(KEYWORD_LINE, (_m, space: string, key: string, rest: string) => `${space}${key[0]!.toUpperCase()}${key.slice(1)}${rest}`);
  });
  const text = lines.join("\n");
  return text ? `${text}\n` : "";
}

export function sketchToArea(sketch: AreaSketch, _defaults: Defaults): Area {
  const issues = sketchIssues(sketch);
  if (issues.errors.length) throw new Error(issues.errors.join("; "));
  const level = LEVEL_SETTINGS[effectiveLevel(sketch)];
  const auto = effectiveLevel(sketch) === "auto";
  return {
    name: sketch.name,
    paths: sketch.paths.map((p) => p.trim()),
    ui: [],
    risk: sketch.risk,
    user_facing: sketch.userFacing,
    ...(sketch.studyBudgetUsd !== undefined ? { voxq_budget_usd: `${sketch.studyBudgetUsd}/month` } : {}),
    // Explicit for every checkpoint, so the area reads the same whatever the defaults are.
    overrides: { ...level.checkpoints },
    prose: intentToProse(sketch.intent),
    mode: level.mode,
    landing: [...level.landing],
    // Non-auto levels inherit the deployment's watch window.
    ...(auto ? { watch: AUTO_WATCH[sketch.risk] } : {}),
  };
}

/** The closest level for the area's effective settings (its own, falling back to `defaults`). */
export function levelOf(area: Area, defaults: Defaults): AutonomyLevel {
  const mode = area.mode ?? defaults.mode;
  const cp = (c: Checkpoint): Mode => area.overrides[c] ?? defaults.checkpoints[c];
  const landing = area.landing ?? defaults.landing;
  if (landing.includes("auto_land") && cp("C") === "advisory") return "auto";
  if (mode === "shadow") return "watch";
  if (cp("A") === "blocking") return "research";
  if (cp("B") === "blocking") return "propose";
  return "patch";
}

const SKETCH_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const isSketchable = (area: Area): boolean => SKETCH_NAME.test(area.name) && area.name.length <= 60;

const STOCK_DEFAULTS: Defaults = {
  mode: "shadow", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"], watch: "2h", decide: "judgement",
};

export function areaToSketch(area: Area, defaults: Defaults = STOCK_DEFAULTS): AreaSketch {
  const budget = area.voxq_budget_usd ? /^(\d+(?:\.\d+)?)\/month$/.exec(area.voxq_budget_usd) : null;
  return {
    name: area.name,
    intent: area.prose.trim().slice(0, 4000),
    paths: [...area.paths],
    risk: area.risk,
    level: levelOf(area, defaults),
    userFacing: area.user_facing,
    ...(budget ? { studyBudgetUsd: Number(budget[1]) } : {}),
  };
}

/** The application map of a parsed policy: one sketch per area whose name the map can carry. */
export function sketchesOf(policy: AutonomyPolicy): AreaSketch[] {
  return policy.areas.filter(isSketchable).map((a) => areaToSketch(a, policy.defaults));
}

/**
 * Apply an edited application map to a policy. The sketches are the complete set of mapped areas: a mapped area that is missing is
 * removed. An area that stays keeps what the map does not carry (its `ui` globs, `decide` backend and unmapped settings); areas whose
 * names the map cannot carry are left alone. Returns the new policy and plain-language notes on what changed meaning.
 */
export function applySketches(policy: AutonomyPolicy, sketches: AreaSketch[]): { policy: AutonomyPolicy; notes: string[] } {
  const notes: string[] = [];
  const names = new Set<string>();
  const next: Area[] = [];
  for (const sketch of sketches) {
    if (names.has(sketch.name)) throw new Error(`area ${sketch.name} appears twice`);
    names.add(sketch.name);
    notes.push(...sketchIssues(sketch).notes);
    const made = sketchToArea(sketch, policy.defaults);
    const old = policy.areas.find((a) => a.name === sketch.name);
    next.push(old ? { ...made, ui: old.ui, ...(old.decide !== undefined ? { decide: old.decide } : {}) } : made);
  }
  for (const old of policy.areas) {
    if (!isSketchable(old)) next.push(old);
    else if (!names.has(old.name)) notes.push(`removes area ${old.name}`);
  }
  return { policy: { ...policy, areas: next }, notes };
}
