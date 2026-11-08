import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeOperationLedger } from "./knowledge-ledger.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ephyra-knowledge-ledger-")); dirs.push(root);
  const directory = join(root, "receipts");
  return { directory, ledger: new KnowledgeOperationLedger(directory) };
}
test("pending, completed and ambiguous receipts survive a new ledger instance", async () => {
  const { directory, ledger } = await fixture();
  expect(await ledger.begin("attempt", "plan")).toEqual({ fresh: true });
  const restarted = new KnowledgeOperationLedger(directory);
  expect(await restarted.begin("attempt", "plan")).toMatchObject({ fresh: false, record: { status: "pending" } });
  await restarted.complete("attempt", { content: "observed resource" });
  expect(await new KnowledgeOperationLedger(directory).begin("attempt", "plan")).toMatchObject({
    fresh: false, record: { status: "done", result: { content: "observed resource" } },
  });
  await ledger.begin("uncertain", "plan");
  await ledger.markAmbiguous("uncertain", "The remote outcome is unknown.");
  expect(await restarted.begin("uncertain", "plan")).toMatchObject({ fresh: false, record: { status: "reconciliation_required" } });
  await expect(restarted.begin("attempt", "different")).rejects.toThrow("another plan");
  await expect(restarted.complete("uncertain", "new result")).rejects.toThrow("not pending");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const file of await readdir(directory)) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
});
test("concurrent claims dispatch at most once, and only one final outcome can be published", async () => {
  const { directory, ledger } = await fixture();
  const claims = await Promise.allSettled(Array.from({ length: 12 }, () => new KnowledgeOperationLedger(directory).begin("same", "plan")));
  expect(claims.filter((result) => result.status === "fulfilled" && result.value.fresh)).toHaveLength(1);
  const outcomes = await Promise.allSettled([ledger.complete("same", { observed: true }), ledger.markAmbiguous("same", "unknown")]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await ledger.get("same"))?.status).not.toBe("pending");
});
test("an interrupted or corrupt claim never becomes permission to dispatch again", async () => {
  const { directory, ledger } = await fixture();
  await ledger.begin("crash", "plan");
  const claim = (await readdir(directory)).find((path) => path.endsWith(".claim"))!;
  await writeFile(join(directory, claim), "");
  await expect(new KnowledgeOperationLedger(directory).begin("crash", "plan")).rejects.toThrow("reconciliation");
});
