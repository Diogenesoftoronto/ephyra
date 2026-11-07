import type { ForgeAdapter, LandingMode, LandingPlan, LandingReceipt } from "@ephyra/core";

export class PartialLandingError extends Error {
  constructor(public readonly receipts: LandingReceipt[], public readonly cause: unknown) {
    super(`landing failed after: ${receipts.map((receipt) => receipt.mode).join(", ") || "none"}`);
    this.name = "PartialLandingError";
  }
}

export function landingFor(modes: LandingMode[], adapters: ForgeAdapter[]) {
  const selected = modes.map((mode) => {
    if (mode === "devenv_live") throw new Error("devenv_live is handled by the runner");
    const name = mode === "radicle_patch" ? "radicle" : mode === "tangled_pull" ? "tangled" : "plain-git";
    const adapter = adapters.find((item) => item.name === name);
    if (!adapter) throw new Error(`no adapter for ${mode}`);
    return { mode, adapter };
  });
  return async (plans: LandingPlan[], authorizationId: string, key: string): Promise<LandingReceipt[]> => {
    if (plans.length !== selected.length || plans.some((plan, i) => plan.mode !== selected[i]?.mode)) {
      throw new Error("plans must match requested landing modes in order");
    }
    const receipts: LandingReceipt[] = [];
    for (let i = 0; i < selected.length; i++) {
      try {
        receipts.push(await selected[i]!.adapter.land(plans[i]!, authorizationId, `${key}:${i}`));
      } catch (error) {
        throw new PartialLandingError(receipts, error);
      }
    }
    return receipts;
  };
}
