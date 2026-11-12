// Offline repository connector for tests and browser scripts: a local git repository stands in for the remote.
// Every fetch and ls-remote is redirected to the local path; nothing reaches the network.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RepositoryConnector, type GitExecutor } from "./repository";

/** A connector whose only remote is a fresh local repository at `source`, committed with `files` (may be empty). */
export function offlineRepository(source: string, files: Record<string, string> = {}): RepositoryConnector {
  const git = (args: string[], cwd?: string, env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", ...env } });
    return { code: result.exitCode, stdout: result.stdout.toString() };
  };
  const must = (args: string[]) => {
    if (git(args, source).code !== 0) throw new Error(`fixture git ${args[0]} failed`);
  };
  mkdirSync(source, { recursive: true });
  must(["init", "--quiet", "--initial-branch=main", "--template="]);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(source, path), content);
  must(["add", "--all"]);
  must(["commit", "--quiet", "--allow-empty", "-m", "offline fixture"]);
  const execute: GitExecutor = async (input) => {
    const args = [...input.args];
    if (args.includes("fetch") || args.includes("ls-remote")) args[args.indexOf("--") + 1] = pathToFileURL(source).href;
    return git(["-c", "protocol.file.allow=always", ...args], undefined, { ...input.env, GIT_ALLOW_PROTOCOL: "file" });
  };
  return new RepositoryConnector({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], execute });
}
