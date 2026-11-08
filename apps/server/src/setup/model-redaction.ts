import { redact } from "@ephyra/agent";
import { Unverified } from "@ephyra/core";

/** Pattern redaction can consume JSON quotes. Sanitize values before serialization, preserving the response contract. */
export function redactModelText(text: string, secrets: string[] = [], max = 150_000): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return redact(text, secrets, max); }
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value, secrets, max);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets, max), clean(item)]));
    return value;
  };
  const result = JSON.stringify(clean(parsed));
  if (result.length > max) throw new Unverified("structured model response exceeds its size limit");
  return result;
}
