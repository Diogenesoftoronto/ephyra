import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReconciliationRequired, type LandingPlan } from "@ephyra/core";
import { BaseMoved, commandRunner, MemoryOperationLedger, RemoteGitAdapter } from "./index";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-remote-"));
  const remote = join(dir, "remote.git");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await commandRunner(["git", ...args], cwd);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git(dir, "init", "--initial-branch=main");
  await git(dir, "init", "--bare", remote);
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.test");
  await writeFile(join(dir, "file"), "before");
  await git(dir, "add", "file");
  await git(dir, "commit", "-m", "base");
  const base = await git(dir, "rev-parse", "HEAD");
  await git(dir, "push", remote, "HEAD:refs/heads/main");
  await writeFile(join(dir, "file"), "after");
  await git(dir, "commit", "-am", "patch");
  const head = await git(dir, "rev-parse", "HEAD");
  const plan: LandingPlan = { trailId: "trail-1", mode: "auto_land", target: "refs/heads/main", expectedBase: base,
    head, proofDigest: `sha256:${"a".repeat(64)}` };
  const ledger = new MemoryOperationLedger();
  let allowed = true;
  const authorize = async () => { if (!allowed) throw new Error("revoked"); };
  return { dir, remote, git, plan, ledger, authorize, revoke: () => { allowed = false; },
    adapter: new RemoteGitAdapter(dir, { remote, scope: "account:workspace", ledger, authorize }),
    close: () => rm(dir, { recursive: true, force: true }) };
}

test("remote landing and rollback update the actual remote conditionally and replay once", async () => {
  const f = await fixture();
  try {
    const receipt = await f.adapter.land(f.plan, "approval", "land");
    expect(await f.git(f.remote, "rev-parse", receipt.target)).toBe(f.plan.head);
    expect(await f.adapter.land(f.plan, "approval", "land")).toEqual(receipt);
    const reverted = await f.adapter.revert(receipt, "rollback");
    expect(await f.git(f.remote, "show", `${reverted.newOid}:file`)).toBe("before");
    expect(await f.git(f.dir, "show", "HEAD:file")).toBe("after");
    expect(await f.adapter.revert(receipt, "rollback")).toEqual(reverted);
  } finally { await f.close(); }
});

test("a moved remote never overwrites another writer", async () => {
  const f = await fixture();
  try {
    await f.git(f.dir, "push", f.remote, `${f.plan.head}:refs/heads/main`);
    await expect(f.adapter.land(f.plan, "approval", "moved")).rejects.toBeInstanceOf(BaseMoved);
    await expect(f.adapter.land(f.plan, "approval", "moved")).rejects.toBeInstanceOf(BaseMoved);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.plan.head);
  } finally { await f.close(); }
});

test("lost push responses require reconciliation and never repeat the push", async () => {
  const f = await fixture();
  let pushes = 0;
  try {
    const adapter = new RemoteGitAdapter(f.dir, {
      remote: f.remote, scope: "account:workspace", ledger: f.ledger, authorize: f.authorize,
      run: async (args, cwd) => {
        const result = await commandRunner(args, cwd);
        if (args[1] === "push") { pushes++; throw new Error("response lost"); }
        return result;
      },
    });
    await expect(adapter.land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(adapter.land(f.plan, "approval", "lost")).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(pushes).toBe(1);
    expect((await f.ledger.get("lost"))?.status).toBe("reconciliation_required");
    expect(await f.git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.plan.head);
  } finally { await f.close(); }
});

test("a trail branch rollback removes only the branch created by that landing", async () => {
  const f = await fixture();
  try {
    const receipt = await f.adapter.land({ ...f.plan, mode: "trail_ref" }, "approval", "branch");
    await f.adapter.revert(receipt, "delete-branch");
    const result = await commandRunner(["git", "show-ref", "--verify", receipt.target], f.remote);
    expect(result.code).not.toBe(0);
    expect(await f.git(f.remote, "rev-parse", "refs/heads/main")).toBe(f.plan.expectedBase);
  } finally { await f.close(); }
});

test("receipt reuse rechecks workspace authority and operation scope", async () => {
  const f = await fixture();
  try {
    await f.adapter.land(f.plan, "approval", "scope");
    const another = new RemoteGitAdapter(f.dir, {
      remote: f.remote, scope: "another-account:workspace", ledger: f.ledger, authorize: f.authorize,
    });
    await expect(another.land(f.plan, "approval", "scope")).rejects.toThrow("idempotency");
    f.revoke();
    await expect(f.adapter.land(f.plan, "approval", "scope")).rejects.toThrow("revoked");
  } finally { await f.close(); }
});
