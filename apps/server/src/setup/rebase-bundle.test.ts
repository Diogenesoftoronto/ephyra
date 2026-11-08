import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repositoryBundle } from "./repository-bundle.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const environment = {
  PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "Offline fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Offline fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function invoke(cwd: string, args: string[], input?: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd, env: environment, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}

function git(cwd: string, args: string[], input?: string) {
  const result = invoke(cwd, args, input);
  if (result.code !== 0) throw new Error(`Offline Git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

async function divergent(format: "sha1" | "sha256") {
  const root = await mkdtemp(join(tmpdir(), "ephyra-rebase-bundle-"));
  directories.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, ["init", "-q", "--template=", "--initial-branch=main", `--object-format=${format}`]);
  await writeFile(join(source, "common.txt"), "common code\n");
  git(source, ["add", "common.txt"]);
  git(source, ["commit", "-qm", "common application base"]);
  const common = git(source, ["rev-parse", "HEAD"]);
  git(source, ["branch", "old-patch"]);
  await writeFile(join(source, "new-default.txt"), "observed refreshed base\n");
  git(source, ["add", "new-default.txt"]);
  git(source, ["commit", "-qm", "default branch moved independently"]);
  const newBase = git(source, ["rev-parse", "HEAD"]);
  git(source, ["checkout", "-q", "old-patch"]);
  await writeFile(join(source, "repair.txt"), "previously proved repair\n");
  git(source, ["add", "repair.txt"]);
  git(source, ["commit", "-qm", "repair based on the previous default"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  const journalBlob = git(source, ["hash-object", "-w", "--stdin"], "PRIVATE OFFLINE JOURNAL CANARY\n");
  const journalTree = git(source, ["mktree"], `100644 blob ${journalBlob}\tprivate-journal.txt\n`);
  const journal = git(source, ["commit-tree", journalTree, "-m", "unrelated private trail history"]);
  const journalRef = "refs/ephyra/trails/019cc100-0000-7000-8000-000000000001/journal";
  git(source, ["update-ref", journalRef, journal]);
  return { root, source, mirror: join(source, ".git"), common, head, newBase, journal, journalBlob, journalRef, format };
}

async function receive(f: Awaited<ReturnType<typeof divergent>>, shallow = false) {
  const bundle = await repositoryBundle(f.mirror, f.head, [f.newBase]);
  const path = join(f.root, "code.bundle");
  await writeFile(path, bundle.bytes);
  const target = join(f.root, "isolated-runner");
  await mkdir(target);
  git(target, ["init", "-q", "--template=", `--object-format=${f.format}`]);
  if (shallow) await writeFile(join(target, ".git", "shallow"), bundle.shallow!.join("\n") + "\n");
  // Match the hosted runner: fetch only the primary advertised export ref, not --all or unrelated refs.
  git(target, ["fetch", "--no-tags", "--", path, bundle.ref]);
  git(target, ["checkout", "-q", "--detach", f.head]);
  return { bundle, path, target };
}

for (const format of ["sha1", "sha256"] as const) {
  test(`a divergent ${format} head bundle carries the refreshed base for a real isolated rebase`, async () => {
    const f = await divergent(format);
    expect(invoke(f.source, ["merge-base", "--is-ancestor", f.newBase, f.head]).code).not.toBe(0);
    const { bundle, path, target } = await receive(f);
    const advertised = git(f.source, ["bundle", "list-heads", path]).split("\n").sort();
    expect(advertised).toEqual([`${f.head} ${bundle.ref}`, `${f.newBase} ${bundle.ref}-base`].sort());
    expect(git(target, ["rev-parse", "HEAD"])).toBe(f.head);
    expect(git(target, ["cat-file", "-t", f.newBase])).toBe("commit");
    expect(git(target, ["show", `${f.newBase}:new-default.txt`])).toBe("observed refreshed base");
    expect(await readFile(join(target, "repair.txt"), "utf8")).toBe("previously proved repair\n");
    git(target, ["rebase", f.newBase]);
    expect(invoke(target, ["merge-base", "--is-ancestor", f.newBase, "HEAD"]).code).toBe(0);
    expect(await readFile(join(target, "new-default.txt"), "utf8")).toBe("observed refreshed base\n");
    expect(await readFile(join(target, "repair.txt"), "utf8")).toBe("previously proved repair\n");
    expect(invoke(target, ["cat-file", "-e", f.journal]).code).not.toBe(0);
    expect(invoke(target, ["cat-file", "-e", f.journalBlob]).code).not.toBe(0);
    expect(git(target, ["for-each-ref", "--format=%(refname)", "refs/ephyra/"])).toBe("");
    expect(git(f.source, ["rev-parse", f.journalRef])).toBe(f.journal);
    expect(git(f.source, ["for-each-ref", "--format=%(refname)", "refs/ephyra/exports/"])).toBe("");
  });

  test(`a shallow divergent ${format} transfer preserves both selected boundaries without journal metadata`, async () => {
    const f = await divergent(format);
    await writeFile(join(f.mirror, "shallow"), [f.head, f.newBase, f.journal].join("\n") + "\n");
    const { bundle, target } = await receive(f, true);
    expect(bundle.shallow).toEqual([f.head, f.newBase].sort());
    expect(git(target, ["cat-file", "-t", f.head])).toBe("commit");
    expect(git(target, ["cat-file", "-t", f.newBase])).toBe("commit");
    expect(git(target, ["show", `${f.newBase}:new-default.txt`])).toBe("observed refreshed base");
    expect(invoke(target, ["cat-file", "-e", f.journal]).code).not.toBe(0);
    expect(invoke(target, ["cat-file", "-e", f.journalBlob]).code).not.toBe(0);
    expect(bundle.shallow).not.toContain(f.journal);
  });
}

test("extra bundle tips are exact, bounded and cleaned up after a rejected request", async () => {
  const f = await divergent("sha1");
  for (const tips of [["HEAD"], ["c".repeat(64)], [f.newBase, f.common], ["f".repeat(40)]]) {
    await expect(repositoryBundle(f.mirror, f.head, tips)).rejects.toThrow();
    expect(git(f.source, ["for-each-ref", "--format=%(refname)", "refs/ephyra/exports/"])).toBe("");
  }
  const deduplicated = await repositoryBundle(f.mirror, f.head, [f.head]);
  const path = join(f.root, "deduplicated.bundle");
  await writeFile(path, deduplicated.bytes);
  expect(git(f.source, ["bundle", "list-heads", path])).toBe(`${f.head} ${deduplicated.ref}`);
});
