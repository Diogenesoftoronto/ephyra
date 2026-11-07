import { createHash } from "node:crypto";
import type { Runner, ServiceProfile } from "@ephyra/core";

/** Hash all profile fields except the digest itself, using recursively sorted object keys. */
export function profileDigest(profile: ServiceProfile): string {
  const { digest: _digest, ...content } = profile;
  return `sha256:${createHash("sha256").update(canonical(content)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("profile contains a non-JSON value");
  return encoded;
}

export type RunnerRequirements = { shell?: boolean; browser?: boolean; checkpoint?: "disk" | "memory" };

/** Return the first runner satisfying all specified requirements, or null. */
export function selectRunner(profile: ServiceProfile, runners: readonly Runner[], requirements: RunnerRequirements = {}): Runner | null {
  return runners.find(({ capabilities: c }) => c.network.includes(profile.network)
    && (!requirements.shell || c.shell)
    && (!requirements.browser || c.browser)
    && (!requirements.checkpoint || c.checkpoint === requirements.checkpoint ||
      (requirements.checkpoint === "disk" && c.checkpoint === "memory"))) ?? null;
}
