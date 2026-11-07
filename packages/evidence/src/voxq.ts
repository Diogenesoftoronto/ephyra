import { ReconciliationRequired, Unverified, type Decision, type ProofItem } from "@ephyra/core";

export class SpendNotApproved extends Error {
  constructor() { super("Respondent spend is not approved"); this.name = "SpendNotApproved"; }
}
export type SurveyCreate = {
  name: string; description?: string; questions: unknown[]; personas: unknown[]; bots: unknown[];
  audience_source?: unknown; product?: unknown; population?: unknown; answer_quality?: unknown;
};
export class VoxqClient {
  constructor(readonly url: string, readonly token: string, readonly request: typeof fetch = fetch) {}
  private async call(path: string, method: "GET" | "POST", body?: unknown, key?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.url.replace(/\/$/, "")}${path}`, {
        method, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (key) throw new ReconciliationRequired(key, "Voxq write outcome unknown");
      throw error;
    }
    if (!response.ok) {
      if (key && response.status >= 500) throw new ReconciliationRequired(key, "Voxq write outcome unknown");
      throw new Error(`Voxq HTTP ${response.status}`);
    }
    return response.json();
  }
  create(survey: SurveyCreate, key: string) { return this.call("/surveys", "POST", survey, key); }
  estimate(id: string, history_survey_ids: string[] = []) {
    return this.call(`/surveys/${encodeURIComponent(id)}/estimate`, "POST", { history_survey_ids });
  }
  simulate(id: string, key: string) { return this.call(`/surveys/${encodeURIComponent(id)}/run`, "POST", undefined, key); }
  publish(id: string, decision: Decision, key: string, budget?: { estimateMicrousd: number; remainingMicrousd: number }) {
    if (decision.verdict !== "approve" || decision.shadow ||
      (decision.by === "policy" && (!budget || !Number.isSafeInteger(budget.estimateMicrousd) ||
        !Number.isSafeInteger(budget.remainingMicrousd) || budget.estimateMicrousd < 0 ||
        budget.estimateMicrousd > budget.remainingMicrousd))) throw new SpendNotApproved();
    return this.call(`/surveys/${encodeURIComponent(id)}/publish`, "POST", { accepting_interviews: true }, key);
  }
  results(id: string, runId: string) {
    return this.call(`/surveys/${encodeURIComponent(id)}/results?run_id=${encodeURIComponent(runId)}`, "GET");
  }
  export(id: string, runId: string) {
    return this.call(`/surveys/${encodeURIComponent(id)}/export?run_id=${encodeURIComponent(runId)}`, "GET");
  }
}

/** A Voxq export combines a selected simulation with current human interviews. */
export type VoxqExport = {
  survey: { id: string };
  provenance: { status: string; run: { id: string; survey_id: string; status: string } | null };
  responses: Array<{ source: string; run_id?: string | null; respondent?: string | null; interview_status?: string | null }>;
};

export function personaProof(data: VoxqExport, study: string, runId: string, report: string): ProofItem {
  const run = data.provenance?.run;
  if (data.survey?.id !== study || data.provenance?.status !== "recorded" || run?.id !== runId ||
      run.survey_id !== study || run.status !== "completed" ||
      !data.responses?.some(row => row.source === "simulation" && row.run_id === runId)) {
    throw new Unverified("completed Voxq simulation evidence");
  }
  return { kind: "persona_study", study, runId, synthetic: true, report };
}

/** The collection ID and spend must come from recorded external evidence, not simulation provenance. */
export function respondentProof(data: VoxqExport, options: {
  study: string; runId: string; via: "share_link" | "embed" | "prolific";
  spendMicrousd: number; expectMet: boolean; report: string; syntheticRunId?: string;
}): ProofItem {
  if (data.survey?.id !== options.study || !options.runId || !options.report ||
      !Number.isSafeInteger(options.spendMicrousd) || options.spendMicrousd < 0 || !Array.isArray(data.responses)) {
    throw new Unverified("Voxq respondent evidence");
  }
  const respondents = new Set(data.responses.filter(row => row.source === "human" &&
    row.interview_status === "completed" && typeof row.respondent === "string" && row.respondent.length > 0)
    .map(row => row.respondent));
  if (!respondents.size) throw new Unverified("completed Voxq respondents");
  return { kind: "voxq_study", ...options, respondents: respondents.size };
}
