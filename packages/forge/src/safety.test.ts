import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlainGitAdapter,
  MemoryOperationLedger,
  digest,
  commandRunner,
  BaseMoved,
} from "./index";

const proof = `sha256:${"a".repeat(64)}`;
const head = "b".repeat(40);
const plan = {
  trailId: "abc",
  mode: "auto_land" as const,
  target: "refs/heads/main",
  expectedBase: "a".repeat(40),
  head,
  proofDigest: proof,
};

test("two instances serialize target and respect a lock held by another process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-lock-"));
  const lockDir = join(dir, "locks");
  try {
    await mkdir(lockDir);
    const lock = join(
      lockDir,
      `${digest(`${dir}\0${plan.target}`).slice(7)}.lock`,
    );
    await writeFile(lock, "external");
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const runner = async () => {
      active++;
      maximum = Math.max(maximum, active);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return { code: 0, stdout: "", stderr: "" };
    };
    const first = new PlainGitAdapter(
      dir,
      runner,
      "w",
      "r",
      new MemoryOperationLedger(),
      lockDir,
    );
    const second = new PlainGitAdapter(
      dir,
      runner,
      "w",
      "r",
      new MemoryOperationLedger(),
      lockDir,
    );
    const a = first.land(plan, "auth", "one");
    const b = second.land(plan, "auth", "two");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(0);
    await unlink(lock);
    await Promise.all([a, b]);
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spool cursor deduplicates earlier entries and ignores incomplete lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-spool-"));
  try {
    const init = await commandRunner(["git", "init", "--bare"], dir);
    expect(init.code).toBe(0);
    const item = {
      old: "0",
      new: head,
      ref: "refs/heads/main",
      principal: "alice",
      time: "2026-01-01T00:00:00Z",
    };
    const line = JSON.stringify(item) + "\n";
    await writeFile(join(dir, "ephyra-spool.jsonl"), line + line + "partial");
    const adapter = new PlainGitAdapter(dir);
    const events = [];
    for await (const event of adapter.events(null)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("alice");
    const resumed = [];
    for await (const event of adapter.events(events[0]!.cursor))
      resumed.push(event);
    expect(resumed).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert refuses a moved target and cleans its temporary worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-revert-fail-"));
  try {
    const git = async (...args: string[]) => {
      const r = await commandRunner(["git", ...args], dir);
      if (r.code) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await writeFile(join(dir, "file"), "a");
    await git("add", "file");
    await git("commit", "-m", "base");
    await writeFile(join(dir, "file"), "b");
    await git("commit", "-am", "change");
    const oid = await git("rev-parse", "HEAD");
    const target = "refs/heads/moved";
    await git("update-ref", target, "HEAD~1");
    // The landing moved `target` from HEAD~1 to oid; someone has since reset it, so the revert must refuse.
    const receipt = {
      mode: "auto_land" as const,
      target,
      oldOid: await git("rev-parse", "HEAD~1"),
      newOid: oid,
      at: new Date().toISOString(),
    };
    await expect(
      new PlainGitAdapter(dir).revert(receipt, "key"),
    ).rejects.toBeInstanceOf(BaseMoved);
    expect(
      (await git("worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
    expect(await git("rev-parse", target)).toBe(
      await git("rev-parse", "HEAD~1"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert command failure leaves target unchanged and removes the worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-revert-error-"));
  try {
    const git = async (...args: string[]) => {
      const result = await commandRunner(["git", ...args], dir);
      if (result.code) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await git("init");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await git("commit", "--allow-empty", "-m", "root");
    const oid = await git("rev-parse", "HEAD");
    const target = await git("symbolic-ref", "HEAD");
    const receipt = {
      mode: "auto_land" as const,
      target,
      oldOid: null,
      newOid: oid,
      at: new Date().toISOString(),
    };
    await expect(
      new PlainGitAdapter(dir).revert(receipt, "root-revert"),
    ).rejects.toThrow();
    expect(await git("rev-parse", target)).toBe(oid);
    expect(
      (await git("worktree", "list", "--porcelain")).match(/^worktree /gm),
    ).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
