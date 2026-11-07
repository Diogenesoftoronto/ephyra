import { expect, test } from "bun:test";
import { MemoryOperationLedger } from "./ledger";

test("ledger preserves results and rejects conflicting plans", async () => {
  const ledger = new MemoryOperationLedger();
  expect(await ledger.begin("key", "digest")).toEqual({ fresh: true });
  await ledger.complete("key", { oid: "abc" });
  expect(await ledger.begin("key", "digest")).toMatchObject({
    fresh: false,
    record: { status: "done", result: { oid: "abc" } },
  });
  await expect(ledger.begin("key", "other")).rejects.toThrow("different plan");
});

test("ambiguous operation remains visible for reconciliation", async () => {
  const ledger = new MemoryOperationLedger();
  await ledger.begin("key", "digest");
  await ledger.markAmbiguous("key", "unknown outcome");
  expect(await ledger.get("key")).toMatchObject({
    status: "reconciliation_required",
  });
});
