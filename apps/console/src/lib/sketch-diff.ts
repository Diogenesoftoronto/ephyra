import { AUTONOMY_LEVELS, type AreaSketch } from "@ephyra/core";

export type FieldChange = { field: "level" | "risk" | "paths" | "intent" | "userFacing" | "studyBudgetUsd"; before: string; after: string };
export type AreaChange =
  | { name: string; kind: "added"; after: AreaSketch }
  | { name: string; kind: "removed"; before: AreaSketch }
  | { name: string; kind: "changed"; before: AreaSketch; after: AreaSketch; fields: FieldChange[] }
  | { name: string; kind: "same"; after: AreaSketch };

const levelLabel = (l: AreaSketch["level"]) => AUTONOMY_LEVELS.find((x) => x.id === l)?.label ?? l;

export function fieldChanges(a: AreaSketch, b: AreaSketch): FieldChange[] {
  const out: FieldChange[] = [];
  if (a.level !== b.level) out.push({ field: "level", before: levelLabel(a.level), after: levelLabel(b.level) });
  if (a.risk !== b.risk) out.push({ field: "risk", before: a.risk, after: b.risk });
  if (a.userFacing !== b.userFacing) out.push({ field: "userFacing", before: a.userFacing ? "user-facing" : "internal", after: b.userFacing ? "user-facing" : "internal" });
  if (a.paths.join("\n") !== b.paths.join("\n")) out.push({ field: "paths", before: a.paths.join(", ") || "none", after: b.paths.join(", ") || "none" });
  if (a.intent.trim() !== b.intent.trim()) out.push({ field: "intent", before: a.intent.trim() || "empty", after: b.intent.trim() || "empty" });
  if ((a.studyBudgetUsd ?? 0) !== (b.studyBudgetUsd ?? 0)) {
    out.push({ field: "studyBudgetUsd", before: `$${a.studyBudgetUsd ?? 0}/month`, after: `$${b.studyBudgetUsd ?? 0}/month` });
  }
  return out;
}

/** Compare two maps by area name. Order follows `after`, then removed areas in their old order. */
export function diffSketches(before: readonly AreaSketch[], after: readonly AreaSketch[]): AreaChange[] {
  const old = new Map(before.map((a) => [a.name, a]));
  const seen = new Set<string>();
  const out: AreaChange[] = after.map((a): AreaChange => {
    seen.add(a.name);
    const prev = old.get(a.name);
    if (!prev) return { name: a.name, kind: "added", after: a };
    const fields = fieldChanges(prev, a);
    return fields.length ? { name: a.name, kind: "changed", before: prev, after: a, fields } : { name: a.name, kind: "same", after: a };
  });
  for (const b of before) if (!seen.has(b.name)) out.push({ name: b.name, kind: "removed", before: b });
  return out;
}

export const changedCount = (changes: readonly AreaChange[]): number => changes.filter((c) => c.kind !== "same").length;
