import { createHash } from "node:crypto";
import type { ForgeCapabilities, LandingMode } from "@ephyra/core";
export class BaseMoved extends Error {
  constructor(public readonly target: string) {
    super(`base moved: ${target}`);
    this.name = "BaseMoved";
  }
}
export const digest = (s: string) =>
  `sha256:${createHash("sha256").update(s).digest("hex")}`;
export const caps = (
  adapter: string,
  modes: LandingMode[],
  verified: boolean,
): ForgeCapabilities => ({
  adapter,
  events: verified,
  conditionalWrites: verified,
  proposals: false,
  ci: false,
  signing: false,
  landingModes: modes,
  customRefs: verified ? "supported" : "unknown",
  verified,
});
