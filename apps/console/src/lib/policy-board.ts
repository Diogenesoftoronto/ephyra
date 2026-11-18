import { AUTONOMY_LEVELS, type AreaSketch, type AutonomyLevel } from "@ephyra/core";
import { changedCount, diffSketches } from "./sketch-diff.ts";

/** Pure logic for the compact policy board: the level meter, the one-line summary, and when inline edits are safe. */

export const LEVEL_STEPS = AUTONOMY_LEVELS.length;

/** Watch is 1, Auto-land is 5. */
export const levelStep = (level: AutonomyLevel): number =>
  AUTONOMY_LEVELS.findIndex((l) => l.id === level) + 1;

export const levelLabel = (level: AutonomyLevel): string =>
  AUTONOMY_LEVELS.find((l) => l.id === level)?.label ?? level;

/** What a screen reader hears for the pips, e.g. "Autonomy: Patch, 4 of 5". */
export const meterLabel = (level: AutonomyLevel): string =>
  `Autonomy: ${levelLabel(level)}, ${levelStep(level)} of ${LEVEL_STEPS}`;

export const riskTone = (risk: AreaSketch["risk"]): "bad" | "warn" | "neutral" =>
  risk === "critical" ? "bad" : risk === "high" ? "warn" : "neutral";

/** The row shows one path and counts the rest. */
export const pathSummary = (paths: readonly string[]): { first: string | null; more: number } => ({
  first: paths[0] ?? null,
  more: Math.max(0, paths.length - 1),
});

export const parsePaths = (text: string): string[] =>
  text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Why a new area name cannot be used, or null. An empty name is not an error yet. */
export function areaNameError(name: string, taken: readonly string[]): string | null {
  if (name === "") return null;
  if (!NAME.test(name) || name.length > 60) return "Lowercase letters, numbers and dashes.";
  if (taken.includes(name)) return "That area already exists.";
  return null;
}

export type BoardCounts = { areas: number; auto: number; critical: number };

export const boardCounts = (sketches: readonly AreaSketch[]): BoardCounts => ({
  areas: sketches.length,
  auto: sketches.filter((s) => s.level === "auto").length,
  critical: sketches.filter((s) => s.risk === "critical").length,
});

/** "9 areas · 5 land by themselves · 1 critical". Counted from the sketches only; zero counts are left out. */
export function boardSummary(sketches: readonly AreaSketch[]): string {
  const c = boardCounts(sketches);
  const parts = [`${c.areas} area${c.areas === 1 ? "" : "s"}`];
  if (c.auto > 0) parts.push(c.auto === 1 ? "1 lands by itself" : `${c.auto} land by themselves`);
  if (c.critical > 0) parts.push(`${c.critical} critical`);
  return parts.join(" · ");
}

/** How many areas a working copy adds, removes or changes against the published map. No working copy is no changes. */
export const pendingChanges = (
  published: readonly AreaSketch[],
  working: readonly AreaSketch[] | null,
): number => (working ? changedCount(diffSketches(published, working)) : 0);

export const changesLabel = (n: number): string => `${n} change${n === 1 ? "" : "s"}`;

type DraftLike = { path: string; status: string; content: string; baseDigest: string; messages: readonly unknown[] };
type DocLike = { content: string; digest: string };

/**
 * An open draft that nobody has worked in: same text as the published document, started from it, no conversation.
 * Saving the board into such a draft overwrites nothing, so it does not block inline edits.
 */
export const untouchedDraft = (draft: DraftLike, doc: DocLike): boolean =>
  draft.status === "open" &&
  draft.baseDigest === doc.digest &&
  draft.content === doc.content &&
  draft.messages.length === 0;

/** The open draft of `path` that inline edits would overwrite, if there is one. */
export function blockingDraft<D extends DraftLike>(drafts: readonly D[], path: string, doc: DocLike): D | null {
  return drafts.find((d) => d.path === path && d.status === "open" && !untouchedDraft(d, doc)) ?? null;
}

/** An untouched open draft of `path` that a save can reuse instead of opening a second one. */
export function reusableDraft<D extends DraftLike>(drafts: readonly D[], path: string, doc: DocLike): D | null {
  return drafts.find((d) => d.path === path && untouchedDraft(d, doc)) ?? null;
}
