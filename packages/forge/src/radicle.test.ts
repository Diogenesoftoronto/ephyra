import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { RadicleAdapter } from "./radicle";
import { MemoryOperationLedger } from "./ledger";
import { ReconciliationRequired, type LandingPlan } from "@ephyra/core";

// Recorded upstream radicle-cli 0.17 examples/rad-cob-show.md (not a live Radicle run).
test("COB list and show produce stable resumable revision events", async () => {
  const list = await readFile(
    new URL("./fixtures/rad-cob-list.txt", import.meta.url),
    "utf8",
  );
  const show = await readFile(
    new URL("./fixtures/rad-cob-show.json", import.meta.url),
    "utf8",
  );
  const commands: string[][] = [];
  const run = async (args: string[]) => {
    commands.push(args);
    return { code: 0, stdout: args[2] === "list" ? list : show, stderr: "" };
  };
  const adapter = new RadicleAdapter(".", "rad:example", run);
  const events = [];
  for await (const event of adapter.events(null)) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "proposal.opened",
    occurredAt: "2022-12-15T17:28:04.000Z",
  });
  const resumed = [];
  for await (const event of adapter.events(events[0]!.cursor))
    resumed.push(event);
  expect(resumed).toHaveLength(0);
  expect(commands[0]?.slice(0, 3)).toEqual(["rad", "cob", "list"]);
});

test("COB comment maps its original author, timestamp and body", async () => {
  const show = await readFile(
    new URL("./fixtures/rad-cob-show.json", import.meta.url),
    "utf8",
  );
  const patch = JSON.parse(show);
  const id = patch.timeline[0];
  // Synthetic comment added to the upstream snapshot to exercise the parser.
  patch.revisions[id].discussion.comments["comment-id"] = {
    author: "did:key:reviewer",
    edits: [{ timestamp: 1671125285000, body: "Review text" }],
  };
  const { parseRadicleCob } = await import("./radicle");
  const events = parseRadicleCob(
    id,
    JSON.stringify(patch),
    "workspace",
    "repo",
  );
  expect(events[1]).toMatchObject({
    kind: "review.comment",
    actor: "did:key:reviewer",
    body: "Review text",
  });
});

async function writableFixture() {
  const snapshot = JSON.parse(await readFile(new URL("./fixtures/rad-cob-show.json", import.meta.url), "utf8"));
  const patch = snapshot.timeline[0] as string;
  const plan: LandingPlan = { trailId: "trail", mode: "radicle_patch", target: "refs/patches",
    expectedBase: snapshot.revisions[patch].base, head: snapshot.revisions[patch].oid, proofDigest: `sha256:${"a".repeat(64)}` };
  const ledger = new MemoryOperationLedger();
  const commands: string[][] = [];
  let lost = false;
  const run = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "git") {
      if (lost) throw new Error("lost response");
      return { code: 0, stdout: `Patch ${patch} opened`, stderr: "" };
    }
    if (args[2] === "archive") snapshot.state.status = "archived";
    return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
  };
  const adapter = new RadicleAdapter(".", "rad:scoped", run, "workspace", {
    ledger, scope: "owner:workspace", authorize: async () => {},
  });
  return { adapter, plan, snapshot, ledger, commands, lose: () => { lost = true; } };
}

test("scoped Radicle patch writes retain observed identities and replay without a second proposal", async () => {
  const f = await writableFixture();
  const receipt = await f.adapter.land(f.plan, "approval", "create");
  expect(receipt.externalId).toBe(f.snapshot.timeline[0]);
  expect(await f.adapter.land(f.plan, "approval", "create")).toEqual(receipt);
  expect(f.commands.filter(args => args[0] === "git")).toHaveLength(1);
  expect(f.commands[0]).toContain(`patch.base=${f.plan.expectedBase}`);
  const withdrawn = await f.adapter.revert(receipt, "withdraw");
  expect(f.snapshot.state.status).toBe("archived");
  expect(await f.adapter.revert(receipt, "withdraw")).toEqual(withdrawn);
  expect(f.commands.filter(args => args[2] === "archive")).toHaveLength(1);
});

test("an unknown native push result is never replaced with a fabricated patch ID or repeated", async () => {
  const f = await writableFixture();
  f.lose();
  await expect(f.adapter.land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
  await expect(f.adapter.land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(f.commands.filter(args => args[0] === "git")).toHaveLength(1);
  expect((await f.ledger.get("lost"))?.status).toBe("reconciliation_required");
});

test("native receipt readback must bind the newest revision to the exact base and head", async () => {
  const f = await writableFixture();
  f.snapshot.revisions[f.snapshot.timeline[0]].oid = "f".repeat(40);
  await expect(f.adapter.land(f.plan, "approval", "wrong-head")).rejects.toBeInstanceOf(ReconciliationRequired);
  expect((await f.ledger.get("wrong-head"))?.status).toBe("reconciliation_required");
});
