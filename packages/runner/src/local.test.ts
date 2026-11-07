import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceProfile, Trail } from "@ephyra/core";
import { LeaseExpired, LocalRunner } from "./local.ts";

const root = await mkdtemp(join(tmpdir(), "runner-test-"));
const repo = join(root, "repo");
const profile: ServiceProfile = {
  name: "test", digest: "x", network: "egress", readOnlyProd: true, credentials: [],
  limits: { cpu: 1, memoryMb: 100, diskMb: 100, timeoutS: 30 },
};
const trail = { id: "trail" } as Trail;
const run = async (...args: string[]) => {
  const p = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const exit = await p.exited;
  if (exit) throw new Error(await new Response(p.stderr).text());
};
let commit: string;
beforeAll(async () => {
  await run("git", "init", repo);
  await Bun.write(join(repo, "file"), "original");
  await run("git", "-C", repo, "add", ".");
  await run("git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial");
  commit = (await Bun.$`git -C ${repo} rev-parse HEAD`.quiet()).text().trim();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("local lifecycle, secrets, paths, snapshot, CAS and lease", async () => {
  const runner = new LocalRunner(join(root, "runner"), { trusted: true });
  const h = await runner.allocate({ trail, attempt: 1, repoUrl: repo, commit, profile, leaseS: 60 });
  process.env.EPHYRA_PLANTED_SECRET = "do-not-inherit";
  const output = [];
  for await (const item of runner.exec(h, ["sh", "-c", "printf %s \"${EPHYRA_PLANTED_SECRET-unset}\""], { deadlineMs: 5000 })) {
    output.push(item);
  }
  expect(output).toContainEqual({ stream: "stdout", chunk: "unset" });
  delete process.env.EPHYRA_PLANTED_SECRET;
  await expect(runner.writeFile(h, "../escape", "x")).rejects.toThrow();
  await symlink(root, join(h.workdir, "escape"));
  await expect(runner.writeFile(h, "escape/bad", "x")).rejects.toThrow();
  await runner.writeFile(h, "file", "changed");
  const ref = (await runner.exportArtifacts(h, ["file"]))[0]!;
  expect(ref.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(await readFile(join(root, "runner", "artifacts", ref.digest.slice(7)), "utf8")).toBe("changed");
  const snapshot = await runner.checkpoint(h);
  const restored = await runner.restore(snapshot.snapshotId, { trail, attempt: 2, profile });
  expect(new TextDecoder().decode((await runner.readFile(restored, "file"))!)).toBe("changed");
  const receipt = await runner.destroy(h);
  expect(await runner.destroy(h)).toEqual(receipt);
  await runner.destroy(restored);
  const expired = await runner.allocate({ trail, attempt: 3, repoUrl: repo, commit, profile, leaseS: 0 });
  await expect(runner.readFile(expired, "file")).rejects.toBeInstanceOf(LeaseExpired);
  await runner.destroy(expired);
});

test("deadline kills a process group including grandchildren", async () => {
  const runner = new LocalRunner(join(root, "timeout"), { trusted: true });
  const h = await runner.allocate({ trail, attempt: 1, repoUrl: repo, commit, profile });
  const marker = join(root, "escaped-child");
  const output = [];
  for await (const item of runner.exec(h, ["sh", "-c", `(sleep 1; touch "${marker}") & wait`], { deadlineMs: 100 })) {
    output.push(item);
  }
  expect(output.some((item) => "timedOut" in item && item.timedOut)).toBe(true);
  await Bun.sleep(1200);
  expect(await Bun.file(marker).exists()).toBe(false);
  await runner.destroy(h);
});
