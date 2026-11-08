import { expect, test } from "bun:test";
import type { ProofItem, Risk } from "@ephyra/core";
import { evaluateProof, evaluateProofBeforeC, requiredProof, autoLandAllowed } from "./index";

const items: ProofItem[] = [
  { kind: "repro_before", probe: "p", result: "fail", log: "log" },
  { kind: "repro_after", probe: "p", result: "pass", log: "log" },
  {
    kind: "tests",
    suite: "suite",
    passed: 1,
    failed: 0,
    newFailures: 0,
    log: "log",
  },
  {
    kind: "diff_scope",
    files: 1,
    lines: 1,
    exportedTypesChanged: false,
    paths: ["a"],
  },
  { kind: "regression_probes", ran: ["p"], failed: [] },
  { kind: "intent_probes", ran: ["p"], failed: [] },
  { kind: "bug_review", reviewer: "reviewer", findings: [] },
  {
    kind: "story_render",
    surface: "web",
    stories: ["s"],
    failed: [],
    uncovered: [],
  },
  {
    kind: "story_interaction",
    surface: "web",
    stories: ["s"],
    failed: [],
    log: "log",
  },
  {
    kind: "story_visual_diff",
    surface: "web",
    baselineSha: "base",
    changed: ["s"],
    explained: ["s"],
    artefacts: "path",
  },
  {
    kind: "visual_approval",
    by: "person",
    at: "2026-01-01T00:00:00Z",
    approved: ["s"],
  },
  { kind: "recording", path: "video", what: "flow" },
  {
    kind: "persona_study",
    study: "study",
    runId: "run",
    synthetic: true,
    report: "report",
  },
  {
    kind: "traffic_replay",
    hunter: "hunter",
    diffs: 0,
    unexplained: 0,
    report: "report",
  },
  {
    kind: "voxq_study",
    study: "study",
    runId: "run",
    respondents: 1,
    via: "share_link",
    spendMicrousd: 0,
    expectMet: true,
    report: "report",
  },
];
const risks: Risk[] = ["low", "medium", "high", "critical"];
test("high-risk machine evidence reaches human C without claiming that a human already approved", () => {
  for (const risk of ["high", "critical"] as const) {
    const flags = { ui: true, userFacing: true };
    expect(evaluateProof(items, risk, flags).passed).toBe(false);
    expect(evaluateProofBeforeC(items, risk, flags)).toEqual({ passed: true, missing: [], awaitingHumanC: true });
    const absentReplay = evaluateProofBeforeC(items.filter(item => item.kind !== "traffic_replay"), risk, flags);
    expect(absentReplay.passed).toBe(false);
    expect(absentReplay.missing).toContain("traffic_replay");
    expect(evaluateProof(items, risk, { ...flags, humanApprovedC: true }).passed).toBe(true);
  }
});
for (const risk of risks)
  for (const ui of [false, true])
    for (const userFacing of [false, true]) {
      test(`proof matrix ${risk} ui=${ui} userFacing=${userFacing}`, () => {
        const flags = { ui, userFacing, humanApprovedC: true };
        const required = requiredProof(risk, flags);
        expect(evaluateProof(items, risk, flags).passed).toBe(true);
        expect(required.includes("story_render")).toBe(ui);
        expect(required.includes("story_visual_diff")).toBe(
          ui && risk !== "low",
        );
        expect(required.includes("persona_study")).toBe(
          userFacing && risk !== "low",
        );
        expect(required.includes("voxq_study")).toBe(
          userFacing && (risk === "high" || risk === "critical"),
        );
        expect(autoLandAllowed(risk)).toBe(risk !== "critical");
        for (const requirement of required) {
          if (
            requirement === "critical_manual_landing" ||
            requirement === "human_approval_c"
          ) {
            expect(
              evaluateProof(items, risk, { ...flags, humanApprovedC: false })
                .passed,
            ).toBe(false);
          } else {
            const remove =
              requirement === "recording_or_terminal_recording"
                ? "recording"
                : requirement;
            expect(
              evaluateProof(
                items.filter((item) => item.kind !== remove),
                risk,
                flags,
              ).passed,
            ).toBe(false);
          }
        }
      });
    }

test("invalid results cannot satisfy proof", () => {
  const flags = { ui: true, userFacing: true, humanApprovedC: true };
  const invalid: Partial<Record<ProofItem["kind"], object>> = {
    tests: { newFailures: 1 },
    regression_probes: { failed: ["p"] },
    intent_probes: { failed: ["p"] },
    bug_review: { findings: [{ severity: "medium", text: "bug" }] },
    story_render: { uncovered: ["missing"] },
    story_interaction: { failed: ["s"] },
    story_visual_diff: { explained: [] },
    visual_approval: { approved: [] },
    traffic_replay: { unexplained: 1 },
    voxq_study: { expectMet: false },
  };
  for (const [kind, changes] of Object.entries(invalid)) {
    const broken = items.map((item) =>
      item.kind === kind ? ({ ...item, ...changes } as ProofItem) : item,
    );
    expect(evaluateProof(broken, "high", flags).passed).toBe(false);
  }
  const terminal = items.map((item) =>
    item.kind === "recording"
      ? ({
          kind: "terminal_recording",
          story: "s",
          tape: "t",
          what: "flow",
        } as ProofItem)
      : item,
  );
  expect(evaluateProof(terminal, "high", flags).passed).toBe(true);
});
