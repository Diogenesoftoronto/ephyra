import type { DecideBackend, JudgementRequest } from "@ephyra/core";
import { SystemOneHttpDecide, type SystemOneOptions } from "./systemone.ts";

/** TypeSafe's documented request and response: https://api.typesafe.ai/openapi.json */
export class TypeSafeDecide implements DecideBackend {
  readonly kind = "byok:typesafe" as const;
  readonly alias: string;
  readonly supports: DecideBackend["supports"];
  private readonly client: SystemOneHttpDecide;
  constructor(options: SystemOneOptions) {
    this.client = new SystemOneHttpDecide(options, "typesafe-wire");
    this.alias = options.alias;
    this.supports = options.supports;
  }
  decide(req: JudgementRequest, opts: { idempotencyKey: string; signal?: AbortSignal }) {
    return this.client.decide(req, opts);
  }
}
