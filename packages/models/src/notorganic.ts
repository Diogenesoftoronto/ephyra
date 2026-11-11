import {
  JudgementResponse,
  ExtractionResponse,
  ExtractionForecastRequest,
  ExtractionForecastResponse,
  type DecideBackend,
  type ExtractBackend,
  type ForecastBackend,
} from "@ephyra/core";
import type { JudgementRequest, ExtractionRequest } from "@ephyra/core";
import { dpopProof } from "./dpop.ts";
import { postJson, type HttpOptions } from "./http.ts";
import { recordUsage, UnexpectedIdentity, type UsageHook } from "./usage.ts";
import type { Purpose, AccessTokenProvider } from "./registry.ts";

export type NotOrganicOptions = {
  alias: string; endpoint: string; tokenProvider: AccessTokenProvider; keys: CryptoKeyPair;
  expectedIdentities?: readonly string[]; onUsage?: UsageHook; purpose: Purpose;
  http?: Omit<HttpOptions, "key" | "signal">;
};

abstract class NotOrganicClient {
  readonly kind = "notorganic" as const;
  readonly alias: string;
  constructor(protected readonly options: NotOrganicOptions) { this.alias = options.alias; }
  protected async send(path: string, body: unknown, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const url = new URL(path, this.options.endpoint).href;
    const token = await this.options.tokenProvider.getAccessToken();
    return postJson(url, body, async () => ({
      Authorization: `DPoP ${token}`, DPoP: await dpopProof(url, token, this.options.keys),
    }), {
      ...this.options.http, key: opts.idempotencyKey, signal: opts.signal,
    });
  }
}

export class NotOrganicDecide extends NotOrganicClient implements DecideBackend {
  readonly supports = ["noul", "choice", "score"] as const;
  async decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const result = JudgementResponse.parse(await this.send("/v1/judgement", { ...req, allow_fallback: req.allow_fallback ?? false }, opts));
    await recordUsage(this.options, result, opts.idempotencyKey);
    return result;
  }
}

export class NotOrganicExtract extends NotOrganicClient implements ExtractBackend {
  async extract(req: ExtractionRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const result = ExtractionResponse.parse(await this.send("/v1/extraction", req, opts));
    await recordUsage(this.options, result, opts.idempotencyKey);
    return result;
  }
}

/**
 * Clairic forecast through Not Organic `/v1/extraction` (contract v1: `forecast` fields with horizon/interval).
 * Usage is recorded by the caller, which owns the ledger entry for the whole forecast operation.
 */
export class NotOrganicForecast extends NotOrganicClient implements ForecastBackend {
  readonly requestedModel = "extraction";
  async forecast(req: ExtractionForecastRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const body = ExtractionForecastRequest.parse({ model: this.requestedModel, ...req });
    const result = ExtractionForecastResponse.parse(await this.send("/v1/extraction", body, opts));
    if (this.options.expectedIdentities?.length && !this.options.expectedIdentities.includes(result.model))
      throw new UnexpectedIdentity(result.model);
    return result;
  }
}
