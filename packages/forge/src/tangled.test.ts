import { expect, test } from "bun:test";
import { ReconciliationRequired, type LandingPlan } from "@ephyra/core";
import { MemoryOperationLedger } from "./ledger";
import { TangledAdapter, type TangledMethod, type TangledWriteOptions } from "./tangled";
import { boundedCommandRunner } from "./command";

function fixture() {
  const repo = "did:plc:repoxyz";
  const ledger = new MemoryOperationLedger();
  const plan: LandingPlan = { trailId: "trail-1", mode: "tangled_pull", target: "refs/heads/main",
    head: "b".repeat(40), expectedBase: "a".repeat(40), proofDigest: `sha256:${"c".repeat(64)}` };
  type Stored = { uri: string; cid: string; value: Record<string, unknown> };
  const records = new Map<string, Stored>();
  const requests: { method: TangledMethod; input: Record<string, unknown> }[] = [];
  let source: string | null = null;
  let pushes = 0;
  let lost = false;
  let allowed = true;
  const writes: TangledWriteOptions = { repositoryDid: repo, scope: "owner:workspace",
    authorize: async () => { if (!allowed) throw new Error("revoked"); },
    rpc: async (method, input) => {
      requests.push({ method, input });
      if (method === "com.atproto.repo.getRecord") return records.get(`${input.collection}/${input.rkey}`)!;
      if (method === "com.atproto.repo.listRecords") {
        return { records: [...records.values()].filter(record => record.uri.includes(`/${input.collection}/`)) };
      }
      if (method === "com.atproto.repo.createRecord") {
        const saved = { uri: `at://${repo}/${input.collection}/fixture-ticket`, cid: "bafyreticketversionone",
          value: { ...(input.record as Record<string, unknown>), "x-tngl-editor": "did:plc:owner" } };
        records.set(`${input.collection}/fixture-ticket`, saved);
        if (lost) throw new Error("response lost after accepted write");
        return { uri: saved.uri, cid: saved.cid };
      }
      if (method === "org.tangled.review.submitPatch") {
        const patch = input.patch as Record<string, unknown>;
        const saved = { uri: `at://${repo}/org.tangled.review.patch/bafyrepatchversion`, cid: "bafyrepatchversion",
          value: { $type: "org.tangled.review.patch", ticket: patch.ticket, base: patch.base, head: patch.head,
            createdAt: "2026-11-08T10:00:00.000Z", "x-tngl-editor": "did:plc:owner" } };
        records.set("org.tangled.review.patch/bafyrepatchversion", saved);
        return { uri: saved.uri, cid: saved.cid };
      }
      const previous = records.get(`${input.collection}/${input.rkey}`)!;
      if (input.swapRecord !== previous.cid) throw new Error("InvalidSwap");
      const saved = { ...previous, cid: "bafyreticketversionclosed", value: input.record as Record<string, unknown> };
      records.set(`${input.collection}/${input.rkey}`, saved);
      return { uri: saved.uri, cid: saved.cid };
    },
  };
  const run = async (args: string[]) => {
    if (args[1] === "ls-remote") {
      if (args.at(-1) === "refs/heads/main") {
        return { code: 0, stdout: `${plan.expectedBase}\trefs/heads/main\n`, stderr: "" };
      }
      return { code: source ? 0 : 2, stdout: source ? `${source}\trefs/heads/ephyra/trail-1\n` : "", stderr: "" };
    }
    if (args[1] === "push") { source = plan.head; pushes++; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const adapter = () => new TangledAdapter(".", `https://knot.example.test/${repo}`, run, ledger, writes);
  return { plan, records, requests, ledger, adapter, lose: () => { lost = true; }, revoke: () => { allowed = false; }, pushes: () => pushes };
}

test("Tangled pull creation uses current ticket/submitPatch contracts and exact recorded versions", async () => {
  const f = fixture();
  const receipt = await f.adapter().land(f.plan, "approval", "pull");
  expect(receipt.externalId).toBe("at://did:plc:repoxyz/org.tangled.track.ticket/fixture-ticket");
  expect(receipt.externalVersion).toBe("bafyreticketversionone");
  expect(receipt.externalRevision).toBe("at://did:plc:repoxyz/org.tangled.review.patch/bafyrepatchversion");
  const submit = f.requests.find(request => request.method === "org.tangled.review.submitPatch")!;
  expect(submit.input).toEqual({ repo: "did:plc:repoxyz", patch: {
    ticket: "fixture-ticket", base: { oid: f.plan.expectedBase }, head: { oid: f.plan.head },
    sourceRepo: "did:plc:repoxyz", sourceBranch: "ephyra/trail-1",
  } });
  expect(await f.adapter().land(f.plan, "approval", "pull")).toEqual(receipt);
  expect(f.pushes()).toBe(1);
  expect(f.requests.filter(request => request.method === "com.atproto.repo.createRecord")).toHaveLength(1);
  const reverted = await f.adapter().revert(receipt, "close");
  const put = f.requests.find(request => request.method === "com.atproto.repo.putRecord")!;
  expect(put.input.swapRecord).toBe(receipt.externalVersion);
  expect((put.input.record as { state: string }).state).toBe("closed");
  expect(await f.adapter().revert(receipt, "close")).toEqual(reverted);
  expect(f.requests.filter(request => request.method === "com.atproto.repo.putRecord")).toHaveLength(1);
});

test("a changed pull CID cannot be overwritten by rollback", async () => {
  const f = fixture();
  const receipt = await f.adapter().land(f.plan, "approval", "pull");
  f.records.get("org.tangled.track.ticket/fixture-ticket")!.cid = "bafyreanotherversion";
  await expect(f.adapter().revert(receipt, "stale-close")).rejects.toThrow("changed since");
  expect(f.requests.filter(request => request.method === "com.atproto.repo.putRecord")).toHaveLength(0);
});

test("an accepted ticket with a lost response is never created twice across adapter restarts", async () => {
  const f = fixture();
  f.lose();
  await expect(f.adapter().land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
  await expect(f.adapter().land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(f.requests.filter(request => request.method === "com.atproto.repo.createRecord")).toHaveLength(1);
  expect(f.requests.some(request => request.method === "org.tangled.review.submitPatch")).toBe(false);
  expect((await f.ledger.get("lost:ticket"))?.status).toBe("reconciliation_required");
});

test("native snapshots rescan versioned records and receipt reuse checks revoked authority", async () => {
  const f = fixture();
  const adapter = f.adapter();
  await adapter.land(f.plan, "approval", "pull");
  const initial = [];
  for await (const event of adapter.events(null)) initial.push(event);
  expect(initial.map(event => event.kind)).toEqual(["proposal.opened", "proposal.updated"]);
  const cursor = initial.at(-1)!.cursor;
  const repeated = [];
  for await (const event of adapter.events(cursor)) repeated.push(event);
  expect(repeated).toHaveLength(0);
  f.records.get("org.tangled.track.ticket/fixture-ticket")!.cid = "bafyrechangedticket";
  const changed = [];
  for await (const event of adapter.events(cursor)) changed.push(event);
  expect(changed).toHaveLength(1);
  f.revoke();
  await expect(adapter.land(f.plan, "approval", "pull")).rejects.toThrow("revoked");
});

test("forge default execution bounds output and process lifetime", async () => {
  await expect(boundedCommandRunner({ maxOutputBytes: 16 })([
    process.execPath, "-e", "process.stdout.write('x'.repeat(1000))",
  ], process.cwd())).rejects.toThrow("output limit");
  await expect(boundedCommandRunner({ deadlineMs: 30 })([
    process.execPath, "-e", "setTimeout(() => {}, 60000)",
  ], process.cwd())).rejects.toThrow("deadline");
});
