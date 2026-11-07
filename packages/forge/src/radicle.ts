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
export class RadicleAdapter implements ForgeAdapter {
  readonly name = "radicle";
  async capabilities(): Promise<ForgeCapabilities> {
    return { ...caps(this.name, ["radicle_patch"], false), proposals: true };
  }
  async *events(_cursor: string | null): AsyncIterable<ForgeEvent> {
    throw new Unverified("Radicle event ingestion");
  }
  async prepareLanding(
    _trail: Trail,
    _mode: LandingMode,
    _base: string,
  ): Promise<LandingPlan> {
    throw new Unverified("Radicle landing preparation");
  }
  // Patch push and CI event reference: https://radicle-ci-broker.liw.fi/userguide.html
  async land(
    _plan: LandingPlan,
    _auth: string,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Radicle patch push and receipt");
  }
  async revert(
    _receipt: LandingReceipt,
    _key: string,
  ): Promise<LandingReceipt> {
    throw new Unverified("Radicle revert");
  }
}
