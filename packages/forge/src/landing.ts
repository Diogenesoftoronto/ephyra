import type {
  ForgeAdapter,
  LandingMode,
  LandingPlan,
  LandingReceipt,
} from "@ephyra/core";

export class PartialLandingError extends Error {
  constructor(
    public readonly receipts: LandingReceipt[],
    public override readonly cause: unknown,
  ) {
    super(
      `landing failed after: ${receipts.map((receipt) => receipt.mode).join(", ") || "none"}`,
    );
    this.name = "PartialLandingError";
  }
}

/** Adapters that can open a reviewable proposal, in the order `pull_request` prefers them. */
export const PROPOSAL_FORGES = ["github", "gitlab", "forgejo", "tangled", "radicle"] as const;

/** The adapter a landing mode uses. `pull_request` takes the workspace's proposal-capable forge; there is never a fallback. */
export function adapterForMode(mode: LandingMode, adapters: ForgeAdapter[]): ForgeAdapter {
  if (mode === "devenv_live") throw new Error("devenv_live is handled by the runner");
  const adapter = mode === "pull_request"
    ? PROPOSAL_FORGES.map((name) => adapters.find((item) => item.name === name)).find(Boolean)
    : adapters.find((item) => item.name === (mode === "radicle_patch" ? "radicle" : mode === "tangled_pull" ? "tangled" : "plain-git"));
  if (!adapter) throw new Error(`no adapter for ${mode}`);
  return adapter;
}

export function landingFor(modes: LandingMode[], adapters: ForgeAdapter[]) {
  const selected = modes.map((mode) => ({ mode, adapter: adapterForMode(mode, adapters) }));
  return async (
    plans: LandingPlan[],
    authorizationId: string,
    key: string,
  ): Promise<LandingReceipt[]> => {
    if (
      plans.length !== selected.length ||
      plans.some((plan, i) => plan.mode !== selected[i]?.mode)
    ) {
      throw new Error("plans must match requested landing modes in order");
    }
    const receipts: LandingReceipt[] = [];
    for (let i = 0; i < selected.length; i++) {
      try {
        receipts.push(
          await selected[i]!.adapter.land(
            plans[i]!,
            authorizationId,
            `${key}:${i}`,
          ),
        );
      } catch (error) {
        throw new PartialLandingError(receipts, error);
      }
    }
    return receipts;
  };
}
