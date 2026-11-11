// Hosted System One models through Not Organic, paid from the billing account's wallet.
// Credentials come from that account's Ephyra sign-in session (DPoP keys + rotating refresh token).
import type {
  DecideBackend, ExtractBackend, ExtractionRequest, JudgementRequest, ExtractionForecastRequest, ForecastBackend,
} from "@ephyra/core";
import { NotOrganicDecide, NotOrganicExtract, NotOrganicForecast, type UsageHook } from "@ephyra/models";
import type { NotOrganicSignIn } from "./notorganic.ts";

async function options(signIn: NotOrganicSignIn, did: string, alias: string, purpose: "extract" | "decide.triage", onUsage?: UsageHook) {
  const creds = await signIn.credentialsFor(did);
  return {
    alias, purpose, endpoint: signIn.config.issuer, keys: creds.keys, ...(onUsage ? { onUsage } : {}),
    tokenProvider: { getAccessToken: async () => creds.token },
    // Same transport as sign-in (lets tests and proxies intercept both).
    http: { fetch: signIn.fetch as unknown as typeof fetch },
  };
}

export class HostedDecide implements DecideBackend {
  readonly kind = "notorganic" as const;
  readonly alias = "notorganic-judgement";
  readonly supports = ["noul", "choice", "score"] as const;
  constructor(private readonly signIn: NotOrganicSignIn, private readonly billingDid: string, private readonly onUsage?: UsageHook) {}
  async decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const client = new NotOrganicDecide(await options(this.signIn, this.billingDid, this.alias, "decide.triage", this.onUsage));
    return client.decide({ model: "judgement", ...req }, opts);
  }
}

export class HostedExtract implements ExtractBackend {
  readonly kind = "notorganic" as const;
  readonly alias = "notorganic-extraction";
  constructor(private readonly signIn: NotOrganicSignIn, private readonly billingDid: string, private readonly onUsage?: UsageHook) {}
  async extract(req: ExtractionRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const client = new NotOrganicExtract(await options(this.signIn, this.billingDid, this.alias, "extract", this.onUsage));
    return client.extract({ model: "extraction", ...req }, opts);
  }
}

/** Clairic forecast on the billing account's Not Organic wallet. The forecast service records usage itself. */
export class HostedForecast implements ForecastBackend {
  readonly kind = "notorganic" as const;
  readonly alias = "notorganic-forecast";
  readonly requestedModel = "extraction";
  constructor(private readonly signIn: NotOrganicSignIn, private readonly billingDid: string) {}
  async forecast(req: ExtractionForecastRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    return new NotOrganicForecast(await options(this.signIn, this.billingDid, this.alias, "extract")).forecast(req, opts);
  }
}
