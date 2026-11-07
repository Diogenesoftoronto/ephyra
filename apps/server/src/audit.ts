import { createHash } from "node:crypto";

export interface AuditInput {
  id: string;
  at: string;
  principal: string;
  action: string;
  target: string;
  detail: unknown;
}

export interface AuditEvent extends AuditInput {
  prevHash: string;
  hash: string;
}

/** Canonical JSON sorts object keys recursively; arrays retain their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("audit value is not JSON");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function hashAudit(prevHash: string, input: AuditInput): string {
  return createHash("sha256").update(prevHash).update(canonicalJson(input)).digest("hex");
}

export function verifyAudit(events: readonly AuditEvent[]): boolean {
  let previous = "";
  for (const { hash, prevHash, ...input } of events) {
    if (prevHash !== previous || hashAudit(previous, input) !== hash) return false;
    previous = hash;
  }
  return true;
}

export class MemoryAudit {
  readonly events: AuditEvent[] = [];

  append(input: AuditInput): AuditEvent {
    const prevHash = this.events.at(-1)?.hash ?? "";
    const event = { ...input, prevHash, hash: hashAudit(prevHash, input) };
    this.events.push(structuredClone(event));
    return structuredClone(event);
  }
}
