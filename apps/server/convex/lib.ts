// Shared helpers for Ephyra's Convex functions.

/**
 * Every Ephyra function is called by the Ephyra server only, with a shared secret set on the Convex
 * deployment as EPHYRA_CONVEX_SECRET. A missing secret on the deployment fails closed.
 */
export function requireSecret(provided: string): void {
  const expected = process.env.EPHYRA_CONVEX_SECRET;
  if (!expected || expected.length < 32) throw new Error("EPHYRA_CONVEX_SECRET is not configured");
  if (provided.length !== expected.length) throw new Error("unauthorized");
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  if (diff !== 0) throw new Error("unauthorized");
}

/** Canonical JSON: keys sorted recursively; must match apps/server/src/audit.ts so chains verify there. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("value is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const MINUTE_MS = 60_000;
