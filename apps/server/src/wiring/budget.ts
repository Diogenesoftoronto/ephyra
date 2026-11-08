import { createHash } from "node:crypto";
import { budgetBlocker, type Trail, type UsageDelta } from "@ephyra/core";
import type { ServerContext } from "./context.ts";

export function usageEventId(trailId: string, key: string): string {
  const hex = createHash("sha256").update(JSON.stringify(["ephyra:usage:v1", trailId, key])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function recordTrailUsage(ctx: ServerContext, trailId: string, key: string, usage: UsageDelta): Promise<void> {
  await ctx.emit({ trail: trailId, actor: { kind: "system", id: "usage" }, eventId: usageEventId(trailId, key),
    type: "usage_recorded", data: { operationKey: key, ...usage } });
}

export function workBudget(trail: Trail, stepTimeoutS: number) {
  const reason = budgetBlocker(trail.budget);
  const remainingMs = trail.budget.wallclockMaxS * 1000 - (trail.budget.wallclockUsedMs ?? 0);
  return {
    reason,
    tokens: Math.max(0, trail.budget.tokensMax - trail.budget.tokensUsed),
    wallclockS: Math.min(stepTimeoutS, Math.max(0, remainingMs) / 1000),
    ...(trail.budget.requireKnownCost ? { spendMicrousd: Math.max(0, trail.budget.spendMicrousdMax - trail.budget.spendMicrousdUsed) } : {}),
  };
}
