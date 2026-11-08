import type {
  ProofItem,
  ProofItemKind,
  Risk,
  WatchConfig,
  WatchObservations,
} from "@ephyra/core";

export type ProofFlags = {
  ui: boolean;
  userFacing: boolean;
  personaStudy?: boolean;
  humanApprovedC?: boolean;
  visualChangesApproved?: boolean;
};
export type ProofRequirement =
  | ProofItemKind
  | "persona_study"
  | "human_approval_c"
  | "visual_approval"
  | "recording_or_terminal_recording"
  | "critical_manual_landing";

export function requiredProof(
  risk: Risk,
  flags: ProofFlags,
): ProofRequirement[] {
  const result: ProofRequirement[] = [
    "repro_before",
    "repro_after",
    "tests",
    "diff_scope",
  ];
  if (flags.ui) result.push("story_render", "story_interaction");
  if (risk !== "low") {
    result.push("regression_probes", "intent_probes", "bug_review");
    if (flags.ui) result.push("story_visual_diff", "visual_approval");
    if (flags.userFacing) result.push("persona_study");
  }
  if (risk === "high" || risk === "critical") {
    result.push("traffic_replay", "human_approval_c");
    if (flags.ui) result.push("recording_or_terminal_recording");
    if (flags.userFacing) result.push("voxq_study");
  }
  if (risk === "critical") result.push("critical_manual_landing");
  return result;
}

export function evaluateProof(
  items: ProofItem[],
  risk: Risk,
  flags: ProofFlags,
): { passed: boolean; missing: ProofRequirement[] } {
  const valid = (requirement: ProofRequirement): boolean => {
    if (requirement === "persona_study")
      return items.some(
        (item) => item.kind === "persona_study" && item.synthetic,
      );
    if (requirement === "human_approval_c")
      return flags.humanApprovedC === true;
    if (requirement === "visual_approval")
      return items
        .filter((item) => item.kind === "story_visual_diff")
        .every((diff) =>
          diff.changed.every((change) =>
            items.some(
              (item) =>
                item.kind === "visual_approval" &&
                item.by.trim().length > 0 &&
                item.approved.includes(change),
            ),
          ),
        );
    // Critical can reach ready with human approval, but auto-landing must be forbidden by the caller.
    if (requirement === "critical_manual_landing")
      return flags.humanApprovedC === true;
    if (requirement === "recording_or_terminal_recording")
      return items.some(
        (i) => i.kind === "recording" || i.kind === "terminal_recording",
      );
    return items.some((item) => {
      if (item.kind !== requirement) return false;
      switch (item.kind) {
        case "tests":
          return item.newFailures === 0;
        case "regression_probes":
        case "intent_probes":
          return item.ran.length > 0 && item.failed.length === 0;
        case "bug_review":
          return !item.findings.some((f) => f.severity !== "low");
        case "story_render":
          return (
            item.stories.length > 0 &&
            item.failed.length === 0 &&
            item.uncovered.length === 0
          );
        case "story_interaction":
          return item.stories.length > 0 && item.failed.length === 0;
        case "story_visual_diff":
          return item.changed.every((c) => item.explained.includes(c));
        case "traffic_replay":
          return item.unexplained === 0;
        case "voxq_study":
          return item.respondents > 0 && item.expectMet;
        default:
          return true;
      }
    });
  };
  const missing = requiredProof(risk, flags).filter((r) => !valid(r));
  return { passed: missing.length === 0, missing };
}

export function autoLandAllowed(risk: Risk): boolean {
  return risk !== "critical";
}

/** Checkpoint C cannot approve a proof which cannot yet be presented. Keep its human decision separate from machine evidence. */
export function evaluateProofBeforeC(items: ProofItem[], risk: Risk, flags: ProofFlags) {
  const result = evaluateProof(items, risk, flags);
  const human = new Set<ProofRequirement>(["human_approval_c", "critical_manual_landing"]);
  const missing = result.missing.filter(requirement => !human.has(requirement));
  const awaitingHumanC = result.missing.some(requirement => human.has(requirement));
  return { passed: missing.length === 0, missing, ...(awaitingHumanC ? { awaitingHumanC: true } : {}) };
}
