import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitEvidence, EntireEvidence, filterToCheckpoints, commandRunner } from "./src/index.ts";

test("git evidence identifies the actual revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephyra-git-"));
  try {
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "test"]]) expect((await commandRunner(["git", ...args], dir)).code).toBe(0);
    await writeFile(join(dir, "a"), "needle\n");
    await commandRunner(["git", "add", "a"], dir);
    await commandRunner(["git", "commit", "-m", "add needle"], dir);
    const git = new GitEvidence(dir); const hits = await git.search({ text: "needle", limit: 5 });
    expect(hits).toHaveLength(1); expect(hits[0]!.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(await git.grep("needle")).toContain("a:1:needle");
    expect(await git.blame("a", 1, 1)).toContain(hits[0]!.revision!);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("Entire filters unrecorded checkpoint IDs and fails closed", async () => {
  const run = async () => ({ code: 0, stdout: JSON.stringify([{ id: "a", type: "checkpoint", title: "A" }, { id: "b", type: "checkpoint" }]), stderr: "" });
  const source = new EntireEvidence(".", ["a"], run);
  const hits = await source.search({ text: "x", limit: 10 });
  expect(hits.map(h => h.id)).toEqual(["a"]);
  expect(filterToCheckpoints(hits, [])).toEqual([]);
  await expect(new EntireEvidence(".", [], async () => { throw new Error(); }).search({ text: "x", limit: 1 })).rejects.toThrow("unverified");
});
