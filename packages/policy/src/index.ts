import type { ProofItem, ProofItemKind, Risk, WatchConfig, WatchObservations } from "@ephyra/core";

export type ProofFlags = { ui: boolean; userFacing: boolean; personaStudy?: boolean; humanApprovedC?: boolean; visualChangesApproved?: boolean };
export type ProofRequirement = ProofItemKind | "persona_study" | "human_approval_c" | "visual_approval" | "recording_or_terminal_recording" | "critical_manual_landing";

export function requiredProof(risk: Risk, flags: ProofFlags): ProofRequirement[] {
  const result: ProofRequirement[] = ["repro_before", "repro_after", "tests", "diff_scope"];
  if (flags.ui) result.push("story_render", "story_interaction");
  if (risk !== "low") {
    result.push("regression_probes", "intent_probes", "bug_review");
    if (flags.ui) result.push("story_visual_diff");
    if (flags.userFacing) result.push("persona_study");
  }
  if (risk === "high" || risk === "critical") {
    result.push("traffic_replay", "human_approval_c");
    if (flags.ui) result.push("recording_or_terminal_recording", "visual_approval");
    if (flags.userFacing) result.push("voxq_study");
  }
  if (risk === "critical") result.push("critical_manual_landing");
  return result;
}

export function evaluateProof(items: ProofItem[], risk: Risk, flags: ProofFlags): { passed: boolean; missing: ProofRequirement[] } {
  const valid = (requirement: ProofRequirement): boolean => {
    if (requirement === "persona_study") return flags.personaStudy === true;
    if (requirement === "human_approval_c") return flags.humanApprovedC === true;
    if (requirement === "visual_approval") return flags.visualChangesApproved === true;
    // Critical can reach ready with human approval, but auto-landing must be forbidden by the caller.
    if (requirement === "critical_manual_landing") return flags.humanApprovedC === true;
    if (requirement === "recording_or_terminal_recording") return items.some(i => i.kind === "recording" || i.kind === "terminal_recording");
    return items.some(item => {
      if (item.kind !== requirement) return false;
      switch (item.kind) {
        case "tests": return item.newFailures === 0;
        case "regression_probes": case "intent_probes": return item.ran.length > 0 && item.failed.length === 0;
        case "bug_review": return !item.findings.some(f => f.severity !== "low");
        case "story_render": return item.stories.length > 0 && item.failed.length === 0 && item.uncovered.length === 0;
        case "story_interaction": return item.stories.length > 0 && item.failed.length === 0;
        case "story_visual_diff": return item.changed.every(c => item.explained.includes(c));
        case "traffic_replay": return item.unexplained === 0;
        case "voxq_study": return item.respondents > 0 && item.expectMet;
        default: return true;
      }
    });
  };
  const missing = requiredProof(risk, flags).filter(r => !valid(r));
  return { passed: missing.length === 0, missing };
}

export type WatchResult = { rollback: true; criterion: string } | { rollback: false; advisories: string[]; canClose: boolean };
export function evaluateWatch(config: WatchConfig, obs: WatchObservations, risk: Risk): WatchResult {
  if (obs.fingerprintRecurrences >= (risk === "high" || risk === "critical" ? 1 : 3)) return { rollback: true, criterion: "original fingerprint recurred" };
  if (obs.newFingerprintsInTouchedFiles.length >= 1) return { rollback: true, criterion: "new fingerprint in touched files" };
  if (Object.values(obs.probeConsecutiveFailures).some(n => n >= 2)) return { rollback: true, criterion: "probe failed twice consecutively" };
  if (obs.errorRate && obs.errorRate.current > obs.errorRate.baseline * 1.5 && obs.errorRate.sustainedAboveS >= 600) return { rollback: true, criterion: "error rate exceeded baseline" };
  const advisories = obs.coverageGaps.map(gap => `coverage gap: ${gap}`);
  if (obs.tracerNewClusters > 0) advisories.push("new tracer clusters");
  if (obs.errorRate === null) advisories.push("error rate unavailable");
  return { rollback: false, advisories, canClose: obs.elapsedS >= config.windowS && obs.coverageGaps.length === 0 && obs.errorRate !== null };
}

import type { Checkpoint, Decision, ExtractionRequest, ExtractionResponse, JudgementRequest, JudgementResponse, LandingMode, Signal, TriageResult } from "@ephyra/core";
import { parse as parseYaml } from "yaml";
export type Area = { name: string; paths: string[]; ui: string[]; risk: Risk; user_facing: boolean; voxq_budget_usd?: string; overrides: Partial<Record<Checkpoint, "advisory" | "blocking">>; prose: string; mode?: "shadow" | "enforce" };
export type AutonomyPolicy = { defaults: { mode: "shadow" | "enforce"; checkpoints: Record<Checkpoint, "advisory" | "blocking">; landing: LandingMode[]; watch: string; decide: string }; areas: Area[]; fallback: Area };
export const AUTONOMY_TEMPLATE = `# Autonomy policy\n\n## defaults\nmode: shadow\ncheckpoints: A=advisory B=advisory C=blocking\nlanding: trail_ref\nwatch: 2h\ndecide: judgement\n\n## area: payments\npaths: src/payments/**, src/checkout/**, intents/checkout-*.md\nrisk: critical\nui: webapp/src/checkout/**\nuser_facing: true\nNothing lands without a named human approving C.\n\n## area: cart\npaths: src/cart/**\nrisk: medium\nAgents may reproduce and patch.\n\n## area: marketing-site\npaths: apps/site/**\nrisk: low\nui: apps/site/src/**\nuser_facing: true\nvoxq_budget_usd: 60/month\nLoose edge.\n`;
export function parseAutonomy(md: string): AutonomyPolicy {
  const fallback: Area = { name: "fallback", paths: [], ui: [], risk: "high", user_facing: false, overrides: {}, prose: "" };
  const policy: AutonomyPolicy = { defaults: { mode: "shadow", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"], watch: "2h", decide: "judgement" }, areas: [], fallback };
  let section = ""; let area: Area | undefined;
  const lines = md.split(/(?<=\n)/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r?\n$/, ""); const heading = /^##\s+(defaults|area:\s*(.+))\s*$/.exec(line);
    if (heading) { section = heading[1]!.startsWith("area:") ? "area" : "defaults"; if (section === "area") { area = { ...fallback, name: heading[2]!.trim(), paths: [], ui: [], overrides: {}, prose: "" }; policy.areas.push(area); } return; }
    const match = /^([a-z_]+):\s*(.*?)\s*(?:\s+#.*)?$/.exec(line);
    if (!match) { if (section === "area" && area) area.prose += raw; return; }
    const [, key, val = ""] = match; const error = () => { throw new Error(`line ${index + 1}: invalid ${key}`); };
    if (section === "defaults") {
      if (key === "mode") { if (val !== "shadow" && val !== "enforce") return error(); policy.defaults.mode = val; }
      else if (key === "checkpoints") { for (const part of val.split(/\s+/)) { const m = /^([ABC])=(advisory|blocking)$/.exec(part); if (!m) return error(); policy.defaults.checkpoints[m[1] as Checkpoint] = m[2] as "advisory" | "blocking"; } }
      else if (key === "landing") { const values = val.split(/\s*,\s*|\s*\+\s*/); if (values.some(v => !["trail_ref", "devenv_live", "radicle_patch", "tangled_pull", "auto_land"].includes(v))) return error(); policy.defaults.landing = values as LandingMode[]; }
      else if (key === "watch") policy.defaults.watch = val;
      else if (key === "decide") policy.defaults.decide = val;
    } else if (section === "area" && area) {
      if (key === "paths" || key === "ui") area[key] = val.split(/\s*,\s*/).filter(Boolean);
      else if (key === "risk") { if (!["low", "medium", "high", "critical"].includes(val)) return error(); area.risk = val as Risk; }
      else if (key === "user_facing") { if (val !== "true" && val !== "false") return error(); area.user_facing = val === "true"; }
      else if (key === "voxq_budget_usd") area.voxq_budget_usd = val;
      else area.prose += raw;
    }
  });
  return policy;
}
function glob(pattern: string, path: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) { const c = pattern[i]!; if (c === "*") { if (pattern[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*"; } else if (c === "?") re += "[^/]"; else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"); }
  return new RegExp(re + "$").test(path);
}
export function areaFor(policy: AutonomyPolicy, paths: string[]): Area {
  let best = policy.fallback; let score = -1;
  for (const area of policy.areas) for (const pattern of area.paths) if (paths.some(path => glob(pattern, path))) { const s = pattern.replace(/[*?]/g, "").length; if (s > score) { score = s; best = area; } }
  return best;
}
export function checkpointMode(policy: AutonomyPolicy, area: Area, checkpoint: Checkpoint): "blocking" | "advisory" { return (area.mode ?? policy.defaults.mode) === "shadow" ? "blocking" : area.overrides[checkpoint] ?? policy.defaults.checkpoints[checkpoint]; }
export type Threshold = { duplicate: number; regression: number; conflict: number; actionable: number; ignore: number; severity: number; confidence: number };
export const DEFAULT_THRESHOLDS: Threshold = { duplicate: .7, regression: .7, conflict: .6, actionable: .4, ignore: .8, severity: 2.5, confidence: .5 };
export type Thresholds = Record<string, Threshold>;
export const THRESHOLDS_TEMPLATE = `"judgement-jev/jev-1.14":\n  duplicate: 0.7\n  regression: 0.7\n  conflict: 0.6\n  actionable: 0.4\n  ignore: 0.8\n  severity: 2.5\n  confidence: 0.5\n`;
export function parseThresholds(yaml: string): Thresholds { const value: unknown = parseYaml(yaml); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("thresholds must be a mapping"); return Object.fromEntries(Object.entries(value).map(([id, v]) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`invalid thresholds for ${id}`); const t = { ...DEFAULT_THRESHOLDS, ...v }; for (const [k, n] of Object.entries(t)) if (!(k in DEFAULT_THRESHOLDS) || typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > (k === "severity" ? 4 : 1)) throw new Error(`invalid threshold ${id}.${k}`); return [id, t]; })); }
export function buildPolicyQuestion(area: Area, checkpoint: Checkpoint, facts: { diff_scope: unknown; proof: unknown; exportedTypesChanged: boolean }): JudgementRequest { return { allow_fallback: false, state: { policy: `<untrusted_policy>\n${area.prose}\n</untrusted_policy>`, facts: `<untrusted_facts>\n${JSON.stringify(facts)}\n</untrusted_facts>`, checkpoint }, questions: { verdict: { type: "choice", instructions: "Under the area policy, may the loop proceed without a human?", criteria: { approve: "Proceed", revise: "Revise", reject: "Reject" } } } }; }
export function interpretPolicyAnswer(response: JudgementResponse, thresholds: Thresholds, options: { at: string; shadow: boolean }): Decision | null { const a = response.answers.verdict; if (!thresholds[response.model] || a?.type !== "choice" || a.confidence < thresholds[response.model]!.confidence || !["approve", "revise", "reject"].includes(a.choice)) return null; return { by: "policy", backend: response.model, at: options.at, shadow: options.shadow, verdict: a.choice as Decision["verdict"] }; }
export function buildExtractionRequest(signal: Signal): ExtractionRequest { return { state: `<untrusted_signal>\n${signal.message}\n</untrusted_signal>`, fields: { exception_type: { type: "text", instructions: "Exception or error class name" }, top_app_frame: { type: "text", instructions: "First application frame: path:line" }, affected_count: { type: "number", integer: true, instructions: "Users or requests affected, if stated" }, touched_files: { type: "list", items: "text", instructions: "Application source files mentioned" } } }; }
export type Candidate = { id: string; title: string };
export type Candidates = { open: Candidate[]; closed: Candidate[]; inFlight: Candidate[] };
export function buildTriageRequest(signal: Signal, extracted: ExtractionResponse, candidates: Candidates, area: Area): JudgementRequest {
  const choice = (items: Candidate[], instructions: string) => ({ type: "choice" as const, instructions, criteria: { ...Object.fromEntries(items.filter(i => i.id !== "none").map(i => [i.id, i.title])), none: "No match" } });
  return { allow_fallback: false, state: { signal: `<untrusted_signal>${JSON.stringify(signal)}</untrusted_signal>`, extracted: `<untrusted_extraction>${JSON.stringify(extracted.answers)}</untrusted_extraction>`, candidates: `<untrusted_candidates>${JSON.stringify(candidates)}</untrusted_candidates>`, policy: JSON.stringify({ area: area.name, risk: area.risk }) }, questions: { actionable: { type: "noul", instructions: "Is this caused by our code or configuration?" }, duplicate_of: choice(candidates.open, "Choose the open trail with the same root cause, or none."), regression_of: choice(candidates.closed, "Choose the regressed closed trail, or none."), conflicts_with: choice(candidates.inFlight, "Choose the conflicting in-flight trail, or none."), severity: { type: "score", instructions: "Score severity from 0 to 4.", criteria: ["cosmetic or log noise", "minor", "degraded flow", "core flow broken", "outage or security relevant"] }, route: { type: "choice", instructions: "Choose the next route.", criteria: { auto_fix: "Research and patch", research_only: "Investigate only", human: "Human decision", ignore: "Noise or not our problem" } } } };
}
export function applyTriage(judgement: JudgementResponse, extraction: ExtractionResponse, thresholds: Thresholds, area: Area): TriageResult {
  const t = thresholds[judgement.model]; const a = judgement.answers; const choice = (key: string) => { const x = a[key]; return x?.type === "choice" ? x : undefined; }; const route = choice("route"), duplicate = choice("duplicate_of"), regression = choice("regression_of"), conflict = choice("conflicts_with");
  const actionable = a.actionable?.type === "noul" ? a.actionable.noul : 0.5; const severity = a.severity?.type === "score" ? a.severity.score : 0; const reasons: string[] = [];
  const result: TriageResult = { route: ["auto_fix", "research_only", "human", "ignore"].includes(route?.choice ?? "") ? route!.choice as TriageResult["route"] : "research_only", risk: area.risk, area: area.name, severity, actionable, confidence: { route: route?.confidence ?? 0, duplicateOf: duplicate?.confidence ?? 0 }, backends: { extract: extraction.model, decide: judgement.model }, reasons, notifyHuman: false };
  const probability = (x: typeof route) => x ? x.probabilities[x.choice] ?? 0 : 0;
  if (t && duplicate && duplicate.choice !== "none" && probability(duplicate) >= t.duplicate) { result.duplicateOf = duplicate.choice; reasons.push("duplicate"); }
  if (t && regression && regression.choice !== "none" && probability(regression) >= t.regression) { result.regressionOf = regression.choice; reasons.push("regression"); }
  if (t && conflict && conflict.choice !== "none" && probability(conflict) >= t.conflict) { result.conflictsWith = conflict.choice; reasons.push("conflict"); }
  if (t && (actionable < t.actionable || (route?.choice === "ignore" && probability(route) >= t.ignore))) { result.route = "ignore"; reasons.push("not actionable or confident ignore"); }
  if (t && severity >= t.severity) { result.notifyHuman = true; reasons.push("high severity"); }
  if (!t || (route?.confidence ?? 0) < t.confidence || (duplicate?.confidence ?? 0) < t.confidence) { result.route = "research_only"; reasons.push(!t ? "unknown backend; calibration required" : "low confidence"); if (!t) result.notifyHuman = true; }
  return result;
}
