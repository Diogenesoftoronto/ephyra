import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Runner, RunnerHandle } from "@ephyra/core";
import { RepositoryConnector, type GitExecutor } from "./repository.ts";
import { importRunnerPatch, repositoryBundle } from "./repository-bundle.ts";
import { setupGit } from "./automation.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const environment = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
function invoke(args: string[], cwd?: string, env: Record<string, string | undefined> = environment) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function git(args: string[], cwd?: string) {
  const result = invoke(args, cwd);
  if (result.code) throw new Error(`Offline Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(format: "sha1" | "sha256") {
  const root = await mkdtemp(join(tmpdir(), "ephyra-bundle-test-")); directories.push(root);
  const source = join(root, "source"); await mkdir(source);
  git(["init", "-q", "--template=", `--object-format=${format}`, "--initial-branch=main"], source);
  const commits: string[] = [];
  for (const number of [1, 2, 3]) {
    await writeFile(join(source, "application.txt"), `version ${number}\n`);
    git(["add", "application.txt"], source); git(["commit", "-qm", `fixture ${number}`], source);
    commits.push(git(["rev-parse", "HEAD"], source));
  }
  const execute: GitExecutor = async (input) => {
    const args = [...input.args];
    // Preserve production depth/branch/format behavior; replace the transport only, with an isolated local file URL.
    if (args.includes("fetch") || args.includes("ls-remote")) args[args.indexOf("--") + 1] = pathToFileURL(source).href;
    return invoke(args, undefined, { ...input.env, GIT_ALLOW_PROTOCOL: "file" });
  };
  const connector = new RepositoryConnector({ execute, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
  const directory = join(root, "connected");
  const connection = await connector.prepare({ url: "https://forge.example.org/team/app.git", branch: "main" }, directory);
  const mirror = join(directory, "workspace.git");
  const sourceGit = setupGit(mirror);
  const privateBlob = (await sourceGit(["hash-object", "-w", "--stdin"], { input: "unrelated private journal fixture\n" })).trim();
  const tree = (await sourceGit(["mktree"], { input: `100644 blob ${privateBlob}\tprivate.txt\n` })).trim();
  const privateCommit = (await sourceGit(["commit-tree", tree, "-m", "private journal fixture"])).trim();
  await sourceGit(["update-ref", "refs/ephyra/private", privateCommit]);
  // An unrelated shallow boundary is metadata too; it must not be copied to a code sandbox.
  await writeFile(join(mirror, "shallow"), `${connection.head}\n${privateCommit}\n`);
  return { root, mirror, connection, commits, privateBlob, privateCommit };
}

for (const format of ["sha1", "sha256"] as const) test(`actual depth-1 ${format} connection materializes an exact isolated runner bundle`, async () => {
  const f = await fixture(format);
  expect(git(["rev-parse", "--is-shallow-repository"], f.mirror)).toBe("true");
  expect(f.connection.head).toBe(f.commits[2]!);
  expect(invoke(["cat-file", "-e", f.commits[1]!], f.mirror).code).not.toBe(0);
  const bundle = await repositoryBundle(f.mirror, f.connection.head);
  expect(bundle.shallow).toEqual([f.connection.head]);
  const path = join(f.root, "source.bundle"); await writeFile(path, bundle.bytes);
  expect(git(["bundle", "list-heads", path])).toBe(`${f.connection.head} ${bundle.ref}`);
  const target = join(f.root, "runner"); await mkdir(target);
  git(["init", "-q", "--template=", `--object-format=${format}`], target);
  await writeFile(join(target, ".git", "shallow"), `${bundle.shallow!.join("\n")}\n`);
  git(["fetch", "--no-tags", "--", path, bundle.ref], target);
  git(["checkout", "--detach", "--force", f.connection.head], target);
  expect(git(["rev-parse", "HEAD"], target)).toBe(f.connection.head);
  expect(await readFile(join(target, "application.txt"), "utf8")).toBe("version 3\n");
  expect(git(["for-each-ref", "--format=%(refname)", "refs/ephyra/private"], target)).toBe("");
  expect(invoke(["cat-file", "-e", f.privateCommit], target).code).not.toBe(0);
  expect(invoke(["cat-file", "-e", f.privateBlob], target).code).not.toBe(0);
  expect(git(["for-each-ref", "--format=%(refname)", "refs/ephyra/exports"], f.mirror)).toBe("");
  // A real patch extends the exact shallow base and returns to the host's existing boundary metadata.
  await writeFile(join(target, "application.txt"), "patched after shallow checkout\n");
  git(["add", "application.txt"], target); git(["commit", "-qm", "fixture patch"], target);
  const patched = git(["rev-parse", "HEAD"], target);
  const unsupported = async (): Promise<never> => { throw new Error("The offline transfer fixture does not implement this runner action."); };
  const runner: Runner = {
    name: "offline-transfer-fixture", capabilities: { checkpoint: "none", network: ["egress"], shell: true, browser: false },
    allocate: unsupported, writeFile: unsupported, checkpoint: unsupported, restore: unsupported, exportArtifacts: unsupported, destroy: unsupported,
    async *exec(_handle: RunnerHandle, command: string[]) {
      const result = invoke(command.slice(1), target);
      if (result.stdout) yield { stream: "stdout" as const, chunk: result.stdout };
      yield { exit: result.code, durationMs: 1, timedOut: false };
    },
    readFile: async (_handle: RunnerHandle, path: string) => new Uint8Array(await readFile(join(target, path))),
  };
  const ref = "refs/ephyra/trails/00000000-0000-4000-8000-000000000001/revisions/0002";
  await importRunnerPatch(runner, {} as RunnerHandle, f.mirror, patched, ref);
  expect(git(["rev-parse", ref], f.mirror)).toBe(patched);
  expect(git(["show", `${ref}:application.txt`], f.mirror)).toBe("patched after shallow checkout");
  expect(git(["rev-parse", "refs/heads/main"], f.mirror)).toBe(f.connection.head);
  expect(git(["rev-list", "--count", ref], f.mirror)).toBe("2");
  const next = await repositoryBundle(f.mirror, patched);
  expect(next.shallow).toEqual([f.connection.head]);
  expect(next.shallow).not.toContain(f.privateCommit);
});
