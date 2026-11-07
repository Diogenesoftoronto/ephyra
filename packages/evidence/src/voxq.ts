import { ReconciliationRequired, type Decision } from "@ephyra/core";

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
  export(id: string) { return this.call(`/surveys/${encodeURIComponent(id)}/export`, "GET"); }
}
