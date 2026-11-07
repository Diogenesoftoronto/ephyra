import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseMoved,
  PlainGitAdapter,
  TangledAdapter,
  landingFor,
  commandRunner,
} from "./index";
import { Unverified } from "@ephyra/core";

test("local conditional landing, replay and base moved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-forge-"));
  try {
    const git = async (...args: string[]) => {
      const r = await commandRunner(["git", ...args], dir);
      if (r.code) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await git("init", "--bare");
    const tree = await git("mktree");
    const commit = await commandRunner(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit-tree",
        tree,
        "-m",
        "test",
      ],
      dir,
    );
    const sha = commit.stdout.trim();
    expect(commit.code).toBe(0);
    const a = new PlainGitAdapter(dir);
    const plan = {
      trailId: "123",
      mode: "trail_ref" as const,
      target: "refs/heads/main",
      expectedBase: sha,
      head: sha,
      proofDigest: `sha256:${"a".repeat(64)}`,
    };
    const receipt = await a.land(plan, "auth", "key");
    expect(await a.land(plan, "auth", "key")).toEqual(receipt);
    await expect(
      a.land({ ...plan, head: "0".repeat(40) }, "auth", "key"),
    ).rejects.toThrow("idempotency");
    await expect(
      a.land(
        { ...plan, mode: "auto_land", expectedBase: sha },
        "auth",
        "other",
      ),
    ).rejects.toBeInstanceOf(BaseMoved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unverified Tangled and runner mode", async () => {
  const t = new TangledAdapter();
  expect((await t.capabilities()).verified).toBe(false);
  await expect(async () => {
    for await (const _ of t.events(null)) {
    }
  }).toThrow(Unverified);
  expect(() => landingFor(["devenv_live"], [])).toThrow("runner");
});
