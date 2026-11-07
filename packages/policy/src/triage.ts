import type {
  Checkpoint,
  Decision,
  ExtractionRequest,
  ExtractionResponse,
  JudgementRequest,
  JudgementResponse,
  Signal,
  TriageResult,
} from "@ephyra/core";
import type { Area } from "./autonomy";
import type { Thresholds } from "./thresholds";

/** Wrap untrusted text as data. Angle brackets are escaped so the content can never close (or open) a tag. */
export function untrustedText(label: string, text: string): string {
  return `<untrusted_${label}>\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n</untrusted_${label}>`;
}
/** Same for JSON payloads: `<`, `>` and `&` become \u escapes, which keeps the JSON valid and identical once parsed. */
export function untrustedJson(label: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<untrusted_${label}>${json}</untrusted_${label}>`;
}
export function buildPolicyQuestion(
  area: Area,
  checkpoint: Checkpoint,
  facts: { diff_scope: unknown; proof: unknown; exportedTypesChanged: boolean },
): JudgementRequest {
  return {
    allow_fallback: false,
    state: {
      policy: untrustedText("policy", area.prose),
      facts: untrustedJson("facts", facts),
      checkpoint,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "Under the area policy, may the loop proceed without a human?",
        criteria: { approve: "Proceed", revise: "Revise", reject: "Reject" },
      },
    },
  };
}
export function interpretPolicyAnswer(
  response: JudgementResponse,
  thresholds: Thresholds,
  options: { at: string; shadow: boolean; area: Area; checkpoint: Checkpoint },
): Decision | null {
  const a = response.answers.verdict;
  if (
    (options.area?.risk === "critical" &&
      options.checkpoint === "C" &&
      a?.type === "choice" &&
      a.choice === "approve") ||
    !Object.hasOwn(thresholds, response.model) ||
    a?.type !== "choice" ||
    a.confidence < thresholds[response.model]!.confidence ||
    !["approve", "revise", "reject"].includes(a.choice)
  )
    return null;
  return {
    by: "policy",
    backend: response.model,
    at: options.at,
    shadow: options.shadow,
    verdict: a.choice as Decision["verdict"],
  };
}
export function buildExtractionRequest(signal: Signal): ExtractionRequest {
  return {
    state: untrustedText("signal", signal.message),
    fields: {
      exception_type: {
        type: "text",
        instructions: "Exception or error class name",
      },
      top_app_frame: {
        type: "text",
        instructions: "First application frame: path:line",
      },
      affected_count: {
        type: "number",
        integer: true,
        instructions: "Users or requests affected, if stated",
      },
      touched_files: {
        type: "list",
        items: "text",
        instructions: "Application source files mentioned",
      },
    },
  };
}
export type Candidate = { id: string; title: string };
export type Candidates = {
  open: Candidate[];
  closed: Candidate[];
  inFlight: Candidate[];
};
export function buildTriageRequest(
  signal: Signal,
  extracted: ExtractionResponse,
  candidates: Candidates,
  area: Area,
): JudgementRequest {
  const choice = (items: Candidate[], instructions: string) => ({
    type: "choice" as const,
    instructions,
    criteria: {
      ...Object.fromEntries(
        items.filter((i) => i.id !== "none").map((i) => [i.id, i.title]),
      ),
      none: "No match",
    },
  });
  return {
    allow_fallback: false,
    state: {
      signal: untrustedJson("signal", signal),
      extracted: untrustedJson("extraction", extracted.answers),
      candidates: untrustedJson("candidates", candidates),
      policy: JSON.stringify({ area: area.name, risk: area.risk }),
    },
    questions: {
      actionable: {
        type: "noul",
        instructions: "Is this caused by our code or configuration?",
      },
      duplicate_of: choice(
        candidates.open,
        "Choose the open trail with the same root cause, or none.",
      ),
      regression_of: choice(
        candidates.closed,
        "Choose the regressed closed trail, or none.",
      ),
      conflicts_with: choice(
        candidates.inFlight,
        "Choose the conflicting in-flight trail, or none.",
      ),
      severity: {
        type: "score",
        instructions: "Score severity from 0 to 4.",
        criteria: [
          "cosmetic or log noise",
          "minor",
          "degraded flow",
          "core flow broken",
          "outage or security relevant",
        ],
      },
      route: {
        type: "choice",
        instructions: "Choose the next route.",
        criteria: {
          auto_fix: "Research and patch",
          research_only: "Investigate only",
          human: "Human decision",
          ignore: "Noise or not our problem",
        },
      },
    },
  };
}
export function applyTriage(
  judgement: JudgementResponse,
  extraction: ExtractionResponse,
  thresholds: Thresholds,
  area: Area,
  candidates?: Candidates,
  signalKind?: Signal["kind"],
): TriageResult {
  const t = Object.hasOwn(thresholds, judgement.model)
    ? thresholds[judgement.model]
    : undefined;
  const a = judgement.answers;
  const choice = (key: string) => {
    const x = a[key];
    return x?.type === "choice" ? x : undefined;
  };
  const route = choice("route"),
    duplicate = choice("duplicate_of"),
    regression = choice("regression_of"),
    conflict = choice("conflicts_with");
  const actionable = a.actionable?.type === "noul" ? a.actionable.noul : 0.5;
  const severity = a.severity?.type === "score" ? a.severity.score : 0;
  const reasons: string[] = [];
  const result: TriageResult = {
    route: ["auto_fix", "research_only", "human", "ignore"].includes(
      route?.choice ?? "",
    )
      ? (route!.choice as TriageResult["route"])
      : "research_only",
    risk: area.risk,
    area: area.name,
    severity,
    actionable,
    confidence: {
      route: route?.confidence ?? 0,
      duplicateOf: duplicate?.confidence ?? 0,
    },
    backends: { extract: extraction.model, decide: judgement.model },
    reasons,
    notifyHuman: false,
  };
  const probability = (x: typeof route) =>
    x ? (x.probabilities[x.choice] ?? 0) : 0;
  const offered = (answer: typeof route, list: Candidate[] | undefined) => {
    if (!answer || answer.choice === "none") return false;
    if (!list?.some((candidate) => candidate.id === answer.choice)) {
      reasons.push(`candidate ${answer.choice} was not offered`);
      return false;
    }
    return true;
  };
  if (
    t &&
    duplicate &&
    offered(duplicate, candidates?.open) &&
    duplicate.choice !== "none" &&
    probability(duplicate) >= t.duplicate
  ) {
    result.duplicateOf = duplicate.choice;
    reasons.push("duplicate");
  }
  if (
    t &&
    regression &&
    offered(regression, candidates?.closed) &&
    regression.choice !== "none" &&
    probability(regression) >= t.regression
  ) {
    result.regressionOf = regression.choice;
    reasons.push("regression");
  }
  if (
    t &&
    conflict &&
    offered(conflict, candidates?.inFlight) &&
    conflict.choice !== "none" &&
    probability(conflict) >= t.conflict
  ) {
    result.conflictsWith = conflict.choice;
    reasons.push("conflict");
  }
  if (
    t &&
    (actionable < t.actionable ||
      (route?.choice === "ignore" && probability(route) >= t.ignore))
  ) {
    result.route = "ignore";
    reasons.push("not actionable or confident ignore");
  }
  if (
    t &&
    route?.choice === "ignore" &&
    probability(route) < t.ignore &&
    actionable >= t.actionable
  ) {
    result.route = "research_only";
    reasons.push("ignore probability below threshold");
  }
  const frame = extraction.answers.top_app_frame;
  if (t && frame?.value === null && (frame.p_null ?? 0) > 0.8) {
    const exception =
      signalKind === "user_report" ||
      signalKind === "intent_probe" ||
      signalKind === "story_probe" ||
      signalKind === "regression_replay";
    if (exception || signalKind === undefined) {
      result.route = "human";
      result.notifyHuman = true;
      reasons.push(
        "no application frame; report or probe needs human assessment",
      );
    } else {
      result.route = "ignore";
      reasons.push("no application frame; not our code");
    }
  }
  if (t && severity >= t.severity) {
    result.notifyHuman = true;
    reasons.push("high severity");
  }
  if (
    !t ||
    (route?.confidence ?? 0) < t.confidence ||
    (duplicate?.confidence ?? 0) < t.confidence
  ) {
    result.route = "research_only";
    reasons.push(
      !t ? "unknown backend; calibration required" : "low confidence",
    );
    if (!t) result.notifyHuman = true;
  }
  return result;
}
