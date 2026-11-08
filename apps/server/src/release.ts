import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The release export writes this marker from its exact Git archive. A development checkout has no release revision. */
export function releaseRevision(): string | null {
  try {
    const value = JSON.parse(readFileSync(join(import.meta.dir, "../../../ephyra-release.json"), "utf8"));
    return value.schema === 1 && typeof value.revision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.revision)
      ? value.revision : null;
  } catch { return null; }
}
