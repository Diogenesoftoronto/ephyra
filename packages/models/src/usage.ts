import type { Purpose } from "./registry.ts";

export type UsageRecord = {
  alias: string;
  identity: string;
  purpose: Purpose;
  idempotencyKey: string;
  tokens: number | null;
  costMicrousd: number | null;
};
export type UsageHook = (record: UsageRecord) => void | Promise<void>;

export class UnexpectedIdentity extends Error {
  constructor(readonly identity: string) {
    super(`Unexpected model identity: ${identity}`);
    this.name = "UnexpectedIdentity";
  }
}

export async function recordUsage(
  options: { alias: string; purpose: Purpose; expectedIdentities?: readonly string[]; onUsage?: UsageHook },
  result: { model: string; usage?: { input_tokens?: number; cost_microusd?: number | null } },
  idempotencyKey: string,
): Promise<void> {
  if (options.expectedIdentities && !options.expectedIdentities.includes(result.model)) {
    throw new UnexpectedIdentity(result.model);
  }
  await options.onUsage?.({
    alias: options.alias, identity: result.model, purpose: options.purpose, idempotencyKey,
    tokens: result.usage?.input_tokens ?? null, costMicrousd: result.usage?.cost_microusd ?? null,
  });
}
