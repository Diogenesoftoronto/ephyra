import { expect, test } from "bun:test";
import { MemoryAudit, canonicalJson, verifyAudit } from "./audit.ts";

test("audit chain verifies and detects mutation", () => {
  const audit = new MemoryAudit();
  audit.append({ id: "1", at: "now", principal: "alice", action: "approve", target: "t", detail: { b: 2, a: 1 } });
  audit.append({ id: "2", at: "later", principal: "bob", action: "reject", target: "t", detail: null });
  expect(verifyAudit(audit.events)).toBe(true);
  audit.events[0]!.principal = "mallory";
  expect(verifyAudit(audit.events)).toBe(false);
  expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
});
