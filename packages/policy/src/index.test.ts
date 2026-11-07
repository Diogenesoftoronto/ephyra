import { describe, expect, test } from "bun:test";
import { evaluateProof, evaluateWatch, requiredProof } from "./index.ts";
import type { WatchConfig, WatchObservations, Risk } from "@ephyra/core";

describe("proof", () => {
  for (const risk of ["low", "medium", "high", "critical"] as Risk[])
    for (const ui of [false, true])
      for (const userFacing of [false, true])
        test(`${risk} ui=${ui} user=${userFacing} requires evidence`, () => {
          const flags = { ui, userFacing };
          expect(evaluateProof([], risk, flags).passed).toBe(false);
          expect(requiredProof(risk, flags).includes("story_render")).toBe(ui);
        });
});
const config: WatchConfig = {
  windowS: 60,
  fingerprints: [],
  touchedFiles: [],
  routes: [],
  areaProbes: [],
  baseline: { errorRate: 1 },
  startedAt: "2026-01-01T00:00:00Z",
};
const obs: WatchObservations = {
  elapsedS: 60,
  fingerprintRecurrences: 0,
  newFingerprintsInTouchedFiles: [],
  probeConsecutiveFailures: {},
  errorRate: { current: 1, baseline: 1, sustainedAboveS: 0 },
  tracerNewClusters: 0,
  coverageGaps: [],
};
test("watch boundaries and coverage", () => {
  expect(
    evaluateWatch(config, { ...obs, fingerprintRecurrences: 2 }, "low")
      .rollback,
  ).toBe(false);
  expect(
    evaluateWatch(config, { ...obs, fingerprintRecurrences: 3 }, "low")
      .rollback,
  ).toBe(true);
  expect(
    evaluateWatch(config, { ...obs, fingerprintRecurrences: 1 }, "high")
      .rollback,
  ).toBe(true);
  expect(
    evaluateWatch(
      config,
      {
        ...obs,
        errorRate: { current: 1.5, baseline: 1, sustainedAboveS: 600 },
      },
      "low",
    ).rollback,
  ).toBe(false);
  expect(
    evaluateWatch(
      config,
      {
        ...obs,
        errorRate: { current: 1.6, baseline: 1, sustainedAboveS: 600 },
      },
      "low",
    ).rollback,
  ).toBe(true);
  expect(
    evaluateWatch(config, { ...obs, coverageGaps: ["missing"] }, "low"),
  ).toMatchObject({ canClose: false });
});
import fc from "fast-check";
import {
  applyTriage,
  areaFor,
  parseAutonomy,
  parseThresholds,
  THRESHOLDS_TEMPLATE,
} from "./index.ts";
import type { ExtractionResponse, JudgementResponse } from "@ephyra/core";
test("autonomy example and malformed risk", () => {
  const p = parseAutonomy(
    "## defaults\nmode: enforce\n## area: broad\npaths: src/**\nrisk: low\n## area: narrow\npaths: src/cart/**\nrisk: medium\nKeep this prose.\n",
  );
  expect(areaFor(p, ["src/cart/a.ts"]).name).toBe("narrow");
  expect(p.areas[1]!.prose).toBe("Keep this prose.\n");
  expect(() => parseAutonomy("## area: a\nrisk: bad\n")).toThrow("line 2");
});
test("specific glob wins for arbitrary filenames", () =>
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z]{1,12}$/), (name) => {
      const p = parseAutonomy(
        "## area: broad\npaths: src/**\n## area: narrow\npaths: src/cart/**\n",
      );
      expect(areaFor(p, [`src/cart/${name}`]).name).toBe("narrow");
    }),
  ));
test("low confidence and unknown identities never auto fix", () =>
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 0.499, noNaN: true }),
      (confidence) => {
        const area = parseAutonomy("## area: a\npaths: src/**\n").areas[0]!;
        const response: JudgementResponse = {
          model: "judgement-jev/jev-1.14",
          answers: {
            route: {
              type: "choice",
              choice: "auto_fix",
              confidence,
              probabilities: { auto_fix: confidence },
            },
            duplicate_of: {
              type: "choice",
              choice: "none",
              confidence: 1,
              probabilities: { none: 1 },
            },
          },
        };
        const extraction: ExtractionResponse = {
          model: "extract",
          answers: {},
        };
        expect(
          applyTriage(
            response,
            extraction,
            parseThresholds(THRESHOLDS_TEMPLATE),
            area,
          ).route,
        ).toBe("research_only");
        expect(
          applyTriage({ ...response, model: "unknown" }, extraction, {}, area)
            .route,
        ).toBe("research_only");
      },
    ),
  ));

test("templates, policy overrides and warnings", () => {
  const p = parseAutonomy(AUTONOMY_TEMPLATE);
  expect(p.areas.map((a) => a.name)).toEqual([
    "payments",
    "cart",
    "marketing-site",
  ]);
  expect(p.areas[0]!.risk).toBe("critical");
  expect(
    parseThresholds(THRESHOLDS_TEMPLATE)["judgement-jev/jev-1.14"],
  ).toEqual(DEFAULT_THRESHOLDS);
  const custom = parseAutonomy(
    "## defaults\nmode: enforce\n## area: cart\nmode: shadow\ncheckpoints: C=advisory\nunknown: value\n",
  );
  expect(checkpointMode(custom, custom.areas[0]!, "C")).toBe("blocking");
  expect(custom.warnings[0]).toContain("line 6");
  expect(() => parseAutonomy("## defaults\nmode: nope\n")).toThrow("line 2");
});

import {
  AUTONOMY_TEMPLATE,
  DEFAULT_THRESHOLDS,
  checkpointMode,
  autoLandAllowed,
  interpretPolicyAnswer,
} from "./index.ts";
test("critical C cannot be policy approved", () => {
  const area = parseAutonomy(AUTONOMY_TEMPLATE).areas[0]!;
  const response: JudgementResponse = {
    model: "judgement-jev/jev-1.14",
    answers: {
      verdict: {
        type: "choice",
        choice: "approve",
        confidence: 1,
        probabilities: { approve: 1 },
      },
    },
  };
  expect(
    interpretPolicyAnswer(response, parseThresholds(THRESHOLDS_TEMPLATE), {
      at: "now",
      shadow: false,
      area,
      checkpoint: "C",
    }),
  ).toBeNull();
  expect(autoLandAllowed("critical")).toBe(false);
});

test("triage decision table and offered candidate validation", () => {
  const area = parseAutonomy(AUTONOMY_TEMPLATE).areas[1]!;
  const choice = (value: string, probability = 0.9, confidence = 0.9) => ({
    type: "choice" as const,
    choice: value,
    confidence,
    probabilities: { [value]: probability },
  });
  const response: JudgementResponse = {
    model: "judgement-jev/jev-1.14",
    answers: {
      route: choice("auto_fix"),
      duplicate_of: choice("d"),
      regression_of: choice("r"),
      conflicts_with: choice("c"),
      actionable: { type: "noul", noul: 0.9 },
      severity: {
        type: "score",
        score: 2.5,
        confidence: 1,
        legend: {},
        probabilities: {},
      },
    },
  };
  const extraction: ExtractionResponse = { model: "extract", answers: {} };
  const thresholds = parseThresholds(THRESHOLDS_TEMPLATE);
  const candidates = {
    open: [{ id: "d", title: "D" }],
    closed: [{ id: "r", title: "R" }],
    inFlight: [{ id: "c", title: "C" }],
  };
  const result = applyTriage(
    response,
    extraction,
    thresholds,
    area,
    candidates,
  );
  expect(result).toMatchObject({
    duplicateOf: "d",
    regressionOf: "r",
    conflictsWith: "c",
    notifyHuman: true,
  });
  expect(
    applyTriage(response, extraction, thresholds, area).duplicateOf,
  ).toBeUndefined();
  const ignored = {
    ...response,
    answers: {
      ...response.answers,
      actionable: { type: "noul" as const, noul: 0.39 },
    },
  };
  expect(
    applyTriage(ignored, extraction, thresholds, area, candidates).route,
  ).toBe("ignore");
});

test("parser handles overrides, prose, and line-numbered errors", () => {
  const policy = parseAutonomy(
    "## defaults\nmode: enforce\n## area: cart\npaths: src/**\nlanding: trail_ref + devenv_live\nwatch: 1h\ndecide: local\ncheckpoints: B=advisory C=blocking\nKeep this.\n\n## notes\nrisk: high\n",
  );
  expect(policy.areas[0]).toMatchObject({
    landing: ["trail_ref", "devenv_live"],
    watch: "1h",
    decide: "local",
    prose: "Keep this.\n\n",
    risk: "high",
  });
  for (const bad of [
    "mode = shadow",
    "paths:",
    "watch: soon",
    "checkpoints: C=maybe",
    "risk: bogus",
    "user_facing: yes",
    "landing: unknown",
    "voxq_budget_usd: nope",
  ]) {
    expect(() => parseAutonomy(`## area: test\n${bad}\n`)).toThrow("line 2");
  }
  expect(() => parseAutonomy("## area:\n")).toThrow("line 1");
  expect(parseAutonomy(AUTONOMY_TEMPLATE).warnings).toEqual([]);
});
