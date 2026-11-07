// Hosted System One models through Not Organic, paid from the billing account's wallet.
// Credentials come from that account's Ephyra sign-in session (DPoP keys + rotating refresh token).
import type {
  DecideBackend, ExtractBackend, ExtractionRequest, JudgementRequest,
} from "@ephyra/core";
import { NotOrganicDecide, NotOrganicExtract } from "@ephyra/models";
import type { NotOrganicSignIn } from "./notorganic.ts";

async function options(signIn: NotOrganicSignIn, did: string, alias: string, purpose: "extract" | "decide.triage") {
  const creds = await signIn.credentialsFor(did);
  return {
    alias, purpose, endpoint: signIn.config.issuer, keys: creds.keys,
    tokenProvider: { getAccessToken: async () => creds.token },
    // Same transport as sign-in (lets tests and proxies intercept both).
    http: { fetch: signIn.fetch as unknown as typeof fetch },
  };
}

export class HostedDecide implements DecideBackend {
  readonly kind = "notorganic" as const;
  readonly alias = "notorganic-judgement";
  readonly supports = ["noul", "choice", "score"] as const;
  constructor(private readonly signIn: NotOrganicSignIn, private readonly billingDid: string) {}
  async decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const client = new NotOrganicDecide(await options(this.signIn, this.billingDid, this.alias, "decide.triage"));
    return client.decide({ model: "judgement", ...req }, opts);
  }
}

export class HostedExtract implements ExtractBackend {
  readonly kind = "notorganic" as const;
  readonly alias = "notorganic-extraction";
  constructor(private readonly signIn: NotOrganicSignIn, private readonly billingDid: string) {}
  async extract(req: ExtractionRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    const client = new NotOrganicExtract(await options(this.signIn, this.billingDid, this.alias, "extract"));
    return client.extract({ model: "extraction", ...req }, opts);
  }
}
