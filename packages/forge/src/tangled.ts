import {
  Unverified,
  type ForgeAdapter,
  type ForgeCapabilities,
  type ForgeEvent,
  type LandingPlan,
  type LandingReceipt,
  type LandingMode,
  type Trail,
} from "@ephyra/core";
import { caps } from "./common";
export class TangledAdapter implements ForgeAdapter {
  readonly name = "tangled";
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
  async land(
    _plan: LandingPlan,
    _auth: string,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Tangled writes: design/02-platform.md §1");
  }
  async revert(
    _receipt: LandingReceipt,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Tangled revert");
  }
}
