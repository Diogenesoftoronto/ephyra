import { createHash } from "node:crypto";
import type { StackFrame } from "@ephyra/core";
export type Signalish = {
  exceptionType?: string;
  message?: string;
  frames?: StackFrame[];
};
export function fingerprint(s: Signalish): string {
  const frames = (s.frames ?? []).filter((f) => f.inApp).slice(0, 3);
  const normalized = (s.message ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<uuid>")
    .replace(/\b\d{4}-\d\d-\d\d(?:t\S+)?/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/["'][^"']*["']/g, "<quoted>")
    .replace(/(?:\/[\w.~-]+){2,}/g, "<path>")
    .replace(/\d+/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  const data = frames.length
    ? [
        s.exceptionType ?? "",
        ...frames.map((f) => `${f.file}:${f.fn ?? ""}`),
      ].join("\n")
    : `${s.exceptionType ?? ""}\n${normalized}`;
  return `v1:${createHash("sha256").update(data).digest("hex")}`;
}
