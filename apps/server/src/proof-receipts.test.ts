import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { canonicalJson } from "@ephyra/core";
import type { ProofEvidenceContext } from "@ephyra/agent";
import { composeApplication } from "./application.ts";
import { readConfig } from "./config.ts";
import { TrustedProofReceipts, proofReceiptPath, type ProofReceipt, type ProofReceiptEnvelope } from "./proof-receipts.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const now = new Date("2026-11-08T14:00:00.000Z");
const receipt = (): ProofReceipt => ({ schema: 1, sourceId: "study-service", workspaceId: "workspace-a",
  trailId: "00000000-0000-4000-8000-000000000001", rev: 2, base: "a".repeat(40), head: "b".repeat(40),
  operationKey: "actual-study-operation", observedAt: "2026-11-08T13:00:00.000Z", expiresAt: "2026-11-09T14:00:00.000Z",
  items: [{ kind: "persona_study", synthetic: true, study: "offline-signature-test", runId: "fixture-only",
    report: "Test fixture; no live study was performed." }] });
const context = (value: ProofReceipt): ProofEvidenceContext => ({ trail: { id: value.trailId, rev: value.rev },
  base: value.base, head: value.head } as ProofEvidenceContext);
async function fixture(transport: "directory" | "signed" = "signed") {
  const root = await mkdtemp(join(tmpdir(), "ephyra-proof-receipts-")); temporary.push(root);
  const keys = generateKeyPairSync("ed25519");
  const directory = join(root, "receipts"), trustFile = join(root, "trust.json");
  const grant = { sourceId: "study-service", workspaces: ["workspace-a"], kinds: ["persona_study"], transport,
    ...(transport === "signed" ? { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) } : {}) };
  await writeFile(trustFile, JSON.stringify({ schema: 1, grants: [grant] }));
  const source = new TrustedProofReceipts({ directory, trustFile, now: () => now });
  const envelope = (value: ProofReceipt = receipt()): ProofReceiptEnvelope => ({ receipt: value,
    ...(transport === "signed" ? { signature: sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString("base64url") } : {}) });
  return { root, directory, trustFile, grant, source, envelope };
}

test("signed proof callback survives restart, deduplicates exact replay, and binds exact workspace and patch", async () => {
  const f = await fixture(), value = f.envelope();
  const response = await f.source.routes().request("/callbacks/proof", { method: "POST", body: JSON.stringify(value) });
  expect(response.status).toBe(201);
  expect(await f.source.accept(value)).toEqual(await response.json());
  const restarted = new TrustedProofReceipts({ directory: f.directory, trustFile: f.trustFile, now: () => now });
  expect(await restarted.collect("workspace-a", context(value.receipt))).toMatchObject([
    { source: "signed:study-service", operationKey: "actual-study-operation", items: value.receipt.items },
  ]);
  expect(await restarted.collect("workspace-b", context(value.receipt))).toEqual([]);
  expect(await restarted.collect("workspace-a", context({ ...value.receipt, rev: 3 }))).toEqual([]);
  expect(await restarted.collect("workspace-a", context({ ...value.receipt, head: "c".repeat(40) }))).toEqual([]);
  const conflict = f.envelope({ ...value.receipt, items: [{ ...value.receipt.items[0]!, report: "Different result" } as ProofReceipt["items"][number]] });
  await expect(restarted.accept(conflict)).rejects.toThrow("conflicting");
});

test("signatures, current grants, allowed kinds and completed observations are required", async () => {
  const f = await fixture(), original = f.envelope();
  await expect(f.source.accept({ receipt: original.receipt })).rejects.toThrow("signature");
  await expect(f.source.accept({ ...original, receipt: { ...original.receipt, workspaceId: "workspace-b" } })).rejects.toThrow();
  await expect(f.source.accept(f.envelope({ ...original.receipt, items: [{ kind: "tests", suite: "forged", passed: 1,
    failed: 0, newFailures: 0, log: "not executed" }] }))).rejects.toThrow("grant");
  await expect(f.source.accept(f.envelope({ ...original.receipt, observedAt: "2026-11-08T15:00:00.000Z" }))).rejects.toThrow("observation");
  await expect(f.source.accept(f.envelope({ ...original.receipt, expiresAt: "2026-11-08T13:01:00.000Z" }))).rejects.toThrow("expiry");
  await f.source.accept(original);
  await writeFile(f.trustFile, JSON.stringify({ schema: 1, grants: [] }));
  await expect(f.source.collect("workspace-a", context(original.receipt))).rejects.toThrow("grant");
});

test("operator directory option works without granting unsigned HTTP ingestion; symlink receipts are refused", async () => {
  const f = await fixture("directory"), value = f.envelope();
  const path = proofReceiptPath(f.directory, value.receipt);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  expect(await f.source.collect("workspace-a", context(value.receipt))).toMatchObject([{ source: "operator:study-service" }]);
  await expect(f.source.accept(value)).rejects.toThrow("signed");
  await rm(path);
  const elsewhere = join(f.root, "elsewhere.json"); await writeFile(elsewhere, JSON.stringify(value)); await symlink(elsewhere, path);
  await expect(f.source.collect("workspace-a", context(value.receipt))).rejects.toThrow();
});

test("shipped composition exposes configured signed ingress without test injection", async () => {
  const f = await fixture(), realNow = new Date();
  const value = f.envelope({ ...receipt(), observedAt: new Date(realNow.getTime() - 60_000).toISOString(),
    expiresAt: new Date(realNow.getTime() + 60_000).toISOString() });
  const app = await composeApplication(readConfig({ EPHYRA_API_TOKEN: "t".repeat(32), EPHYRA_DATA_DIR: join(f.root, "data"),
    EPHYRA_PROOF_RECEIPTS_DIR: f.directory, EPHYRA_PROOF_TRUST_FILE: f.trustFile }), { startJobs: false });
  try {
    const response = await app.app.request("/callbacks/proof", { method: "POST", body: JSON.stringify(value) });
    expect(response.status).toBe(201);
    expect((await app.app.request("/v1/trails")).status).toBe(401);
    expect(await new TrustedProofReceipts({ directory: f.directory, trustFile: f.trustFile, now: () => realNow })
      .collect("workspace-a", context(value.receipt))).toHaveLength(1);
  } finally { await app.close(); }
});

test("receipt storage identity changes with every exact binding and never interpolates operation text", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.string({ maxLength: 100 }), (rev, operationKey) => {
    const value = { ...receipt(), rev, operationKey };
    const path = proofReceiptPath("/trusted", value);
    expect(path).toMatch(/^\/trusted\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
    expect(proofReceiptPath("/trusted", { ...value, rev: rev + 1 })).not.toBe(path);
    expect(proofReceiptPath("/trusted", { ...value, workspaceId: "another" })).not.toBe(path);
  }));
});
