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


test("Entire falls back to text when JSON is unsupported and reports unavailability", async () => {
  const { Unavailable } = await import("./src/index.ts");
  let calls = 0;
  const source = new EntireEvidence(".", ["abcdef123456"], async () => {
    calls++;
    return calls === 1
      ? { code: 1, stdout: "", stderr: "unknown flag: --json" }
      : { code: 0, stdout: "abcdef123456 checkpoint example\nabcdef999999 other", stderr: "" };
  });
  expect((await source.search({ text: "example", limit: 5 })).map(hit => hit.id)).toEqual(["abcdef123456"]);
  expect(calls).toBe(2);
  await expect(new EntireEvidence(".", [], async () => ({ code: 1, stdout: "", stderr: "not enabled" }))
    .search({ text: "x", limit: 1 })).rejects.toBeInstanceOf(Unavailable);
});
