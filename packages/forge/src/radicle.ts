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

/** Commands are constructed but not executed until a Radicle integration is verified. */
export function radicleOpenCommand(head: string, message: string): string[] {
  return ["git", "push", "rad", `${head}:refs/patches`, "-o", `patch.message=${message}`];
}

export function radicleRevisionCommand(head: string, patchId: string, message: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(patchId)) throw new Error("invalid patch id");
  return ["git", "push", "rad", `${head}:refs/heads/patches/${patchId}`, "-o", `patch.message=${message}`];
}

export function radicleCommentCommand(revisionId: string, message: string): string[] {
  if (!/^[0-9a-f]{40}$/.test(revisionId)) throw new Error("invalid revision id");
  return ["rad", "patch", "comment", revisionId, "--message", message];
}

/** Parse the documented git-remote-rad output; unknown output is never treated as success. */
export function parseRadiclePush(output: string): { kind: "opened" | "updated"; patchId: string } {
  const opened = output.match(/Patch ([0-9a-f]{40}) opened/);
  if (opened) return { kind: "opened", patchId: opened[1]! };
  const updated = output.match(/Patch ([0-9a-f]{7,40}) updated to revision/);
  if (updated) return { kind: "updated", patchId: updated[1]! };
  throw new Unverified("unrecognized Radicle push output");
}
