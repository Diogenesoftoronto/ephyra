import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Unverified, type Runner, type RunnerHandle } from "@ephyra/core";
import { setupGit } from "./automation.ts";

const limit = 64 * 1024 * 1024;
const oid = (value: string) => {
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value)) throw new Unverified("exact repository commit");
  return value;
};

/** Export only the requested code history; journals, account keys, remotes and unrelated refs never leave the host. */
export async function repositoryBundle(mirror: string, commit: string, additionalCommits: string[] = []) {
  oid(commit);
  if (additionalCommits.length > 1) throw new Unverified("bounded code bundle tips");
  const commits = [...new Set([commit, ...additionalCommits.map(oid)])];
  if (commits.some(value => value.length !== commit.length)) throw new Unverified("code bundle object format");
  const git = setupGit(mirror);
  const directory = await mkdtemp(join(tmpdir(), "ephyra-bundle-"));
  const path = join(directory, "source.bundle");
  const ref = `refs/ephyra/exports/${randomUUID()}`;
  const refs = commits.map((_, index) => index === 0 ? ref : `${ref}-base`);
  try {
    for (const value of commits) {
      const verified = (await git(["rev-parse", `${value}^{commit}`])).trim();
      if (verified !== value) throw new Unverified("repository bundle commit");
    }
    // Git bundles preserve objects but not a shallow repository's missing-parent boundaries.
    // Carry only boundaries reachable from this code commit, never an unrelated journal's boundary.
    let shallow: string[] = [];
    if ((await git(["rev-parse", "--is-shallow-repository"])).trim() === "true") {
      const path = join(mirror, "shallow");
      if ((await stat(path)).size > 4096 * 65) throw new Unverified("bounded repository shallow metadata");
      const boundaries = (await readFile(path, "utf8")).trim().split("\n");
      if (boundaries.length > 4096 || boundaries.some((value) => value.length !== commit.length || oid(value) !== value)) {
        throw new Unverified("repository shallow metadata");
      }
      const reachable = new Set((await git(["rev-list", ...commits])).trim().split("\n"));
      shallow = [...new Set(boundaries.filter((value) => reachable.has(value)))].sort();
    }
    for (const [index, value] of commits.entries()) await git(["update-ref", refs[index]!, value]);
    await git(["bundle", "create", path, ...refs]);
    if ((await stat(path)).size > limit) throw new Unverified("repository bundle exceeds the transfer limit");
    return { bytes: new Uint8Array(await readFile(path)), ref, ...(shallow.length ? { shallow } : {}) };
  } finally {
    for (const temporary of refs) await git(["update-ref", "-d", temporary]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Import a verified patch from a remote runner. A host filesystem path is never passed as its push destination. */
export async function importRunnerPatch(runner: Runner, handle: RunnerHandle, mirror: string, head: string, ref: string) {
  oid(head);
  if (!/^refs\/ephyra\/trails\/[a-f0-9-]+\/revisions\/\d+$/.test(ref)) throw new Unverified("patch revision ref");
  const bundlePath = ".ephyra-transfer.bundle";
  const exportRef = "refs/ephyra/export-patch";
  for (const command of [["git", "update-ref", exportRef, head], ["git", "bundle", "create", bundlePath, exportRef]]) {
    let exit: number | null = null;
    for await (const part of runner.exec(handle, command, { deadlineMs: 120_000 })) if ("exit" in part) exit = part.exit;
    if (exit !== 0) throw new Unverified("patch bundle export");
  }
  const bytes = await runner.readFile(handle, bundlePath);
  if (!bytes?.length || bytes.length > limit) throw new Unverified("bounded patch bundle transfer");
  const directory = await mkdtemp(join(tmpdir(), "ephyra-patch-"));
  const path = join(directory, "patch.bundle");
  const git = setupGit(mirror);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const heads = (await git(["bundle", "list-heads", path])).trim();
    if (heads !== `${head} ${exportRef}`) throw new Unverified("patch bundle identity");
    await git(["bundle", "verify", path]);
    await git(["-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", path, exportRef],
      { env: { GIT_ALLOW_PROTOCOL: "file" } });
    const imported = (await git(["rev-parse", `${head}^{commit}`])).trim();
    if (imported !== head) throw new Unverified("imported patch commit");
    let previous: string | null = null;
    try { previous = (await git(["rev-parse", "--verify", "-q", ref])).trim(); } catch { /* new immutable ref */ }
    if (previous && previous !== head) throw new Unverified("patch revision already points to another commit");
    if (!previous) await git(["update-ref", ref, head, "0".repeat(head.length)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
