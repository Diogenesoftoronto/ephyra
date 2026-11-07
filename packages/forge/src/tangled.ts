import {
  Unverified,
  ReconciliationRequired,
  type OperationLedger,
  type ForgeAdapter,
  type ForgeCapabilities,
  type ForgeEvent,
  type LandingPlan,
  type LandingReceipt,
  type LandingMode,
  type Trail,
} from "@ephyra/core";
import { commandRunner, type CommandRunner } from "./command";
import { MemoryOperationLedger } from "./ledger";
import { digest, caps } from "./common";
export class TangledAdapter implements ForgeAdapter {
  readonly name = "tangled";
  constructor(
    private readonly repoDir = ".",
    private readonly remote = "knot",
    private readonly run: CommandRunner = commandRunner,
    private readonly ledger: OperationLedger = new MemoryOperationLedger(),
  ) {}
  async capabilities(): Promise<ForgeCapabilities> {
    return caps(this.name, ["trail_ref", "tangled_pull"], false);
  }
  async *events(_cursor: string | null): AsyncIterable<ForgeEvent> {
    throw new Unverified(
      "Tangled org.tangled schemas: design/02-platform.md §1",
    );
  }
  async prepareLanding(
    _trail: Trail,
    _mode: LandingMode,
    _base: string,
  ): Promise<LandingPlan> {
    throw new Unverified("Tangled landing preparation");
  }
  async land(plan: LandingPlan, auth: string, key: string): Promise<LandingReceipt> {
    if (plan.mode !== "trail_ref") throw new Unverified("Tangled pull writes");
    if (!auth || !key) throw new Error("authorization and idempotency key required");
    const target = `refs/heads/ephyra/${plan.trailId}`;
    const operation = await this.ledger.begin(key, digest(JSON.stringify([plan, auth])));
    if (!operation.fresh) {
      if (operation.record.status === "done") return operation.record.result as LandingReceipt;
      throw new ReconciliationRequired(key, "push requires reconciliation");
    }
    let result;
    try {
      result = await this.run([
        "git", "push", `--force-with-lease=${target}:`, this.remote, `${plan.head}:${target}`,
      ], this.repoDir);
    } catch {
      await this.ledger.markAmbiguous(key, "push outcome unknown");
      throw new ReconciliationRequired(key, "push outcome unknown");
    }
    if (result.code) {
      await this.ledger.markAmbiguous(key, "push failed; inspect remote before retry");
      throw new ReconciliationRequired(key, "push failed; inspect remote before retry");
    }
    const receipt: LandingReceipt = {
      mode: plan.mode, target, oldOid: null, newOid: plan.head,
      authorizationId: auth, proofDigest: plan.proofDigest, at: new Date().toISOString(),
    };
    await this.ledger.complete(key, receipt);
    return receipt;
  }
  async revert(
    _receipt: LandingReceipt,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Tangled revert");
  }
}
