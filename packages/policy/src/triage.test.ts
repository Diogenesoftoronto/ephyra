import { expect, test } from "bun:test";
import type {
  ExtractionResponse,
  JudgementResponse,
  Signal,
} from "@ephyra/core";
import {
  applyTriage,
  buildTriageRequest,
  parseAutonomy,
  parseThresholds,
  THRESHOLDS_TEMPLATE,
} from "./index";

const area = parseAutonomy("## area: cart\nrisk: medium\n").areas[0]!;
const thresholds = parseThresholds(THRESHOLDS_TEMPLATE);
const candidates = {
  open: [{ id: "d", title: "duplicate" }],
  closed: [{ id: "r", title: "regression" }],
  inFlight: [{ id: "c", title: "conflict" }],
};
const extraction: ExtractionResponse = { model: "extract", answers: {} };
const choice = (value: string, p = 1, confidence = 1) => ({
  type: "choice" as const,
  choice: value,
  confidence,
  probabilities: { [value]: p },
});
const response = (): JudgementResponse => ({
  model: "judgement-jev/jev-1.14",
  answers: {
    actionable: { type: "noul", noul: 1 },
    route: choice("auto_fix"),
    duplicate_of: choice("none"),
    regression_of: choice("none"),
    conflicts_with: choice("none"),
    severity: {
      type: "score",
      score: 0,
      confidence: 1,
      legend: {},
      probabilities: {},
    },
  },
});
const run = (
  answer: JudgementResponse,
  ext = extraction,
  kind?: Signal["kind"],
) => applyTriage(answer, ext, thresholds, area, candidates, kind);

test("six questions use only offered candidate IDs and string state", () => {
  const signal = { message: "data" } as Signal;
  const request = buildTriageRequest(signal, extraction, candidates, area);
  expect(Object.keys(request.questions)).toEqual([
    "actionable",
    "duplicate_of",
    "regression_of",
    "conflicts_with",
    "severity",
    "route",
  ]);
  for (const value of Object.values(request.state as Record<string, string>))
    expect(typeof value).toBe("string");
  for (const [key, id] of [
    ["duplicate_of", "d"],
    ["regression_of", "r"],
    ["conflicts_with", "c"],
  ] as const) {
    const q = request.questions[key!];
    expect(q?.type).toBe("choice");
    if (q?.type === "choice")
      expect(Object.keys(q.criteria)).toEqual([id, "none"]);
  }
});

test("candidate decision rows use exact probability boundaries and offered IDs", () => {
  for (const [question, id, field, boundary] of [
    ["duplicate_of", "d", "duplicateOf", 0.7],
    ["regression_of", "r", "regressionOf", 0.7],
    ["conflicts_with", "c", "conflictsWith", 0.6],
  ] as const) {
    const r = response();
    r.answers[question] = choice(id, boundary);
    expect(run(r)[field]).toBe(id);
    r.answers[question] = choice(id, boundary - 0.001);
    expect(run(r)[field]).toBeUndefined();
    r.answers[question] = choice("invented");
    const result = run(r);
    expect(result[field]).toBeUndefined();
    expect(
      result.reasons.some((reason) => reason.includes("not offered")),
    ).toBe(true);
  }
});

test("ignore, severity, confidence and identity rows", () => {
  const r = response();
  r.answers.actionable = { type: "noul", noul: 0.399 };
  expect(run(r).route).toBe("ignore");
  r.answers.actionable = { type: "noul", noul: 0.4 };
  expect(run(r).route).toBe("auto_fix");
  r.answers.route = choice("ignore", 0.799);
  expect(run(r).route).toBe("research_only");
  r.answers.route = choice("ignore", 0.8);
  expect(run(r).route).toBe("ignore");
  r.answers.route = choice("auto_fix");
  r.answers.severity = {
    type: "score",
    score: 2.5,
    confidence: 1,
    legend: {},
    probabilities: {},
  };
  expect(run(r)).toMatchObject({ route: "auto_fix", notifyHuman: true });
  r.answers.duplicate_of = choice("none", 1, 0.499);
  expect(run(r).route).toBe("research_only");
  r.answers.duplicate_of = choice("none");
  r.answers.route = choice("auto_fix", 1, 0.499);
  expect(run(r).route).toBe("research_only");
  r.model = "toString";
  expect(run(r).route).toBe("research_only");
  r.model = "unknown";
  expect(run(r)).toMatchObject({ route: "research_only", notifyHuman: true });
});

test("null app frame respects the probability and report or probe exception", () => {
  const r = response();
  const ext: ExtractionResponse = {
    model: "extract",
    answers: { top_app_frame: { type: "text", value: null, p_null: 0.81 } },
  };
  expect(run(r, ext, "error").route).toBe("ignore");
  for (const kind of [
    "user_report",
    "intent_probe",
    "story_probe",
    "regression_replay",
  ] as const)
    expect(run(r, ext, kind)).toMatchObject({
      route: "human",
      notifyHuman: true,
    });
  expect(run(r, ext).route).toBe("human");
  ext.answers.top_app_frame!.p_null = 0.8;
  expect(run(r, ext, "error").route).toBe("auto_fix");
});
