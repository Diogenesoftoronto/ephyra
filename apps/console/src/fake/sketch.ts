// STAND-IN for `sketchToArea` / `areaToSketch` (packages/policy, built by another lane). The server does this mapping;
// the console never does. The fake needs *something* so the application map is demonstrable. The table below is
// invented, is not the real mapping, and exists only in this fake. Level is remembered in an HTML comment so a
// round trip is exact; the real policy package derives it from the settings instead.
import { AUTONOMY_LEVELS, type AreaSketch, type AutonomyLevel } from "@ephyra/core";

type Settings = { mode: "shadow" | "enforce"; checkpoints: string; landing: string; watch: string };

export const LEVEL_SETTINGS: Record<AutonomyLevel, Settings> = {
  watch: { mode: "shadow", checkpoints: "A=blocking B=blocking C=blocking", landing: "trail_ref", watch: "2h" },
  research: { mode: "enforce", checkpoints: "A=blocking B=blocking C=blocking", landing: "trail_ref", watch: "2h" },
  propose: { mode: "enforce", checkpoints: "A=blocking B=blocking C=blocking", landing: "trail_ref", watch: "2h" },
  patch: { mode: "enforce", checkpoints: "A=advisory B=advisory C=blocking", landing: "trail_ref", watch: "2h" },
  auto: { mode: "enforce", checkpoints: "A=advisory B=advisory C=advisory", landing: "trail_ref, devenv_live, auto_land", watch: "1h" },
};

const LEVEL_MARK = /^<!--\s*level:\s*(\w+)\s*-->$/;
const KEY = /^([a-z_]+):\s*(.*?)\s*(?:\s+#.*)?$/;
const levels = AUTONOMY_LEVELS.map((l) => l.id as string);

export function renderSketch(a: AreaSketch): string {
  const s = LEVEL_SETTINGS[a.level];
  const lines = [
    `## area: ${a.name}`, `<!-- level: ${a.level} -->`, `paths: ${a.paths.join(", ")}`, `risk: ${a.risk}`, `user_facing: ${a.userFacing}`,
    `mode: ${s.mode}`, `checkpoints: ${s.checkpoints}`, `landing: ${s.landing}`, `watch: ${s.watch}`,
    ...(a.studyBudgetUsd ? [`voxq_budget_usd: ${a.studyBudgetUsd}/month`] : []),
  ];
  return `${lines.join("\n")}\n${a.intent.trim()}\n`;
}

/** Read every `## area:` block back into sketches. Blocks without a level mark are read as Propose. */
export function sketchesOf(md: string): AreaSketch[] {
  const out: AreaSketch[] = [];
  let cur: (AreaSketch & { prose: string[] }) | null = null;
  const flush = () => { if (cur) { const { prose, ...rest } = cur; out.push({ ...rest, intent: prose.join("\n").trim() }); cur = null; } };
  for (const line of md.split("\n")) {
    const head = /^##\s+area:\s*(.+?)\s*$/.exec(line);
    if (head) { flush(); cur = { name: head[1]!, intent: "", paths: [], risk: "high", level: "propose", userFacing: false, prose: [] }; continue; }
    if (/^##\s/.test(line)) { flush(); continue; }
    if (!cur) continue;
    const mark = LEVEL_MARK.exec(line);
    if (mark) { if (levels.includes(mark[1]!)) cur.level = mark[1] as AutonomyLevel; continue; }
    const m = KEY.exec(line);
    if (!m) { cur.prose.push(line); continue; }
    if (m[1] === "paths") cur.paths = m[2]!.split(/\s*,\s*/).filter(Boolean);
    if (m[1] === "risk") cur.risk = m[2] as AreaSketch["risk"];
    if (m[1] === "user_facing") cur.userFacing = m[2] === "true";
    const budget = m[1] === "voxq_budget_usd" ? /^(\d+(?:\.\d+)?)\/month$/.exec(m[2]!) : null;
    if (budget) cur.studyBudgetUsd = Number(budget[1]);
  }
  flush();
  return out;
}

/** Replace every area block with `sketches`, keeping the preamble and `## defaults`. */
export function replaceAreas(md: string, sketches: readonly AreaSketch[]): string {
  const lines = md.split("\n");
  const first = lines.findIndex((l) => /^##\s+area:/.test(l));
  const head = (first < 0 ? lines : lines.slice(0, first)).join("\n").trimEnd();
  const trailing: string[] = [];
  let skip = false;
  for (const l of first < 0 ? [] : lines.slice(first)) {
    if (/^##\s+area:/.test(l)) skip = true;
    else if (/^##\s/.test(l)) skip = false;
    if (!skip) trailing.push(l);
  }
  const rest = trailing.join("\n").trim();
  return `${head}\n\n${sketches.map(renderSketch).join("\n")}${rest ? `\n${rest}\n` : ""}`.replace(/\n{3,}/g, "\n\n");
}
