import { ExtractionResponse, ExtractionForecastRequest, ExtractionForecastResponse, type ExtractBackend, type ExtractionRequest, type ForecastBackend } from "@ephyra/core";
import { z } from "zod";
import { postJson, type HttpOptions } from "./http.ts";
import { recordUsage, UnexpectedIdentity, type UsageHook } from "./usage.ts";

export type WorkersAiOptions = {
  alias: string; accountId: string; credential: string; endpoint?: string;
  expectedIdentities?: readonly string[]; onUsage?: UsageHook;
  http?: Omit<HttpOptions, "key" | "signal">;
};

/** https://developers.cloudflare.com/workers-ai/models/clairic/ */
export class WorkersAiClairicExtract implements ExtractBackend {
  readonly kind = "byok:cloudflare" as const;
  readonly alias: string;
  constructor(private readonly options: WorkersAiOptions) { this.alias = options.alias; }
  async extract(req: ExtractionRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const origin = this.options.endpoint ?? "https://api.cloudflare.com";
    const path = `/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/ai/run/@cf/cloudflare/clairic`;
    const response = await postJson(new URL(path, origin).href, { ...req, model: req.model ?? "clairic" },
      { Authorization: `Bearer ${this.options.credential}` },
      { ...this.options.http, key: opts.idempotencyKey, signal: opts.signal });
    const envelope = z.object({ success: z.literal(true), result: z.unknown() }).parse(response);
    const result = ExtractionResponse.parse(envelope.result);
    await recordUsage({ ...this.options, purpose: "extract" }, result, opts.idempotencyKey);
    return result;
  }
}

/** Clairic forecast fields on Workers AI (BYOK). Same envelope as extraction; the caller records usage. */
export class WorkersAiClairicForecast implements ForecastBackend {
  readonly kind = "byok:cloudflare" as const;
  readonly alias: string;
  readonly requestedModel = "@cf/cloudflare/clairic";
  constructor(private readonly options: WorkersAiOptions) {
    this.alias = options.alias;
  }
  async forecast(req: ExtractionForecastRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const origin = this.options.endpoint ?? "https://api.cloudflare.com";
    const path = `/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/ai/run/@cf/cloudflare/clairic`;
    const body = ExtractionForecastRequest.parse(req);
    const response = await postJson(new URL(path, origin).href, { ...body, model: body.model ?? "clairic" },
      { Authorization: `Bearer ${this.options.credential}` },
      { ...this.options.http, key: opts.idempotencyKey, signal: opts.signal });
    const envelope = z.object({ success: z.literal(true), result: z.unknown() }).parse(response);
    const result = ExtractionForecastResponse.parse(envelope.result);
    if (this.options.expectedIdentities?.length && !this.options.expectedIdentities.includes(result.model))
      throw new UnexpectedIdentity(result.model);
    return result;
  }
}
