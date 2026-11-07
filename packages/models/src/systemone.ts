import { JudgementResponse, Unverified, type DecideBackend, type JudgementRequest } from "@ephyra/core";
import { postJson, type HttpOptions } from "./http.ts";
import { recordUsage, type UsageHook } from "./usage.ts";
import type { Purpose } from "./registry.ts";

export class UnsupportedQuestion extends Error {
  constructor(readonly questionType: string) {
    super(`Unsupported question type: ${questionType}`);
    this.name = "UnsupportedQuestion";
  }
}
export type SystemOneOptions = {
  alias: string; endpoint: string; credential: string; model: string;
  supports: DecideBackend["supports"]; purpose: Purpose;
  expectedIdentities?: readonly string[]; onUsage?: UsageHook;
  http?: Omit<HttpOptions, "key" | "signal">;
};

/** Wire format: https://api.typesafe.ai/openapi.json and pplx-decider deploy.md. */
export class SystemOneHttpDecide implements DecideBackend {
  readonly kind: `selfhosted:${string}`;
  readonly alias: string;
  readonly supports: DecideBackend["supports"];
  constructor(protected readonly options: SystemOneOptions, name: string) {
    this.kind = `selfhosted:${name}`;
    this.alias = options.alias;
    this.supports = options.supports;
  }
  async decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    for (const question of Object.values(req.questions)) {
      if (!this.supports.includes(question.type)) throw new UnsupportedQuestion(question.type);
    }
    if (req.images?.length) throw new Unverified("System One image mapping");
    if (req.allow_fallback) throw new Unverified("System One fallback");
    const body = { model: req.model ?? this.options.model, state: req.state, questions: req.questions };
    const response = await postJson(new URL("/v1/systemone", this.options.endpoint).href, body,
      { Authorization: `Bearer ${this.options.credential}` },
      { ...this.options.http, key: opts.idempotencyKey, signal: opts.signal });
    const result = JudgementResponse.parse(response);
    await recordUsage(this.options, result, opts.idempotencyKey);
    return result;
  }
}
