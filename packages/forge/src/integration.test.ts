import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commandRunner,
  PlainGitAdapter,
  TangledAdapter,
  radicleOpenCommand,
  parseRadiclePush,
} from "./index";

const proof = `sha256:${"a".repeat(64)}`;

test("hook spool, conditional land, isolated revert and Tangled push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-test-"));
  const work = join(dir, "work");
  const bare = join(dir, "bare.git");
  const run = async (cwd: string, ...args: string[]) => {
    const result = await commandRunner(["git", ...args], cwd);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    await run(dir, "init", "work");
    await run(dir, "init", "--bare", "bare.git");
    await run(work, "config", "user.name", "Test");
    await run(work, "config", "user.email", "test@example.test");
    await writeFile(join(work, "file"), "before\n");
    await run(work, "add", "file");
    await run(work, "commit", "-m", "base");
    const base = await run(work, "rev-parse", "HEAD");
    await writeFile(join(work, "file"), "after\n");
    await run(work, "commit", "-am", "change");
    const head = await run(work, "rev-parse", "HEAD");
    const plain = new PlainGitAdapter(bare);
    await plain.installHook();
    await run(work, "push", bare, `${base}:refs/heads/main`);
    const events = [];
    for await (const event of plain.events(null)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]!.commit).toBe(base);
    await run(work, "push", bare, `${head}:refs/heads/other`);
    const plan = {
      trailId: "abc",
      mode: "auto_land" as const,
      target: "refs/heads/main",
      expectedBase: base,
      head,
      proofDigest: proof,
    };
    const receipt = await plain.land(plan, "auth", "land");
    // Revert needs an identity in the repository, independent of the user's worktree.
    await run(bare, "config", "user.name", "Test");
    await run(bare, "config", "user.email", "test@example.test");
    const reverted = await plain.revert(receipt, "revert");
    expect(await run(bare, "show", `${reverted.newOid}:file`)).toBe("before");
    expect(await run(work, "rev-parse", "HEAD")).toBe(head);
    const tangled = new TangledAdapter(work, bare);
    const pushed = await tangled.land(
      { ...plan, mode: "trail_ref" },
      "auth",
      "push",
    );
    expect(await run(bare, "rev-parse", pushed.target)).toBe(head);
    expect(
      await tangled.land({ ...plan, mode: "trail_ref" }, "auth", "push"),
    ).toEqual(pushed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Radicle documented push command and output", () => {
  expect(radicleOpenCommand("HEAD", "title")).toEqual([
    "git",
    "push",
    "rad",
    "HEAD:refs/patches",
    "-o",
    "patch.message=title",
  ]);
  expect(parseRadiclePush(`✓ Patch ${"a".repeat(40)} opened`)).toEqual({
    kind: "opened",
    patchId: "a".repeat(40),
  });
});
