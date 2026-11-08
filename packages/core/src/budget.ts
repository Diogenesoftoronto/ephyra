import type { Budget } from "./schemas.ts";

export type UsageDelta = { tokens: number | null; costMicrousd: number | null; wallMs: number };

function sum(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0
    || !Number.isSafeInteger(left + right)) throw new Error("Invalid budget accounting value");
  return left + right;
}

/** Apply an observed usage receipt. Idempotency belongs to its journal operation/event identity. */
export function accountUsage(budget: Budget, usage: UsageDelta): Budget {
  return {
    ...budget,
    tokensUsed: sum(budget.tokensUsed, usage.tokens ?? 0),
    spendMicrousdUsed: sum(budget.spendMicrousdUsed, usage.costMicrousd ?? 0),
    wallclockUsedMs: sum(budget.wallclockUsedMs ?? 0, usage.wallMs),
    unknownTokenEntries: sum(budget.unknownTokenEntries ?? 0, Number(usage.tokens === null)),
    unknownCostEntries: sum(budget.unknownCostEntries ?? 0, Number(usage.costMicrousd === null)),
  };
}

export function budgetBlocker(budget: Budget): string | null {
  if (budget.tokensUsed >= budget.tokensMax) return "The trail token budget is exhausted.";
  if (budget.spendMicrousdUsed > budget.spendMicrousdMax) return "The trail spending budget is exceeded.";
  if ((budget.wallclockUsedMs ?? 0) >= budget.wallclockMaxS * 1000) return "The trail execution-time budget is exhausted.";
  if ((budget.unknownTokenEntries ?? 0) > 0) return "Token usage is unknown; reconcile usage before continuing.";
  if (budget.requireKnownCost && (budget.unknownCostEntries ?? 0) > 0)
    return "Spending is unknown; reconcile usage before continuing.";
  return null;
}
