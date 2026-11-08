import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { RepositoryConnector, type GitInvocation, type RepositoryInput } from "./repository.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const url = "https://forge.example.com/team/application.git";
const old = "a".repeat(40);
const head = "b".repeat(40);
const trailRef = "refs/heads/ephyra/019cc100-0000-7000-8000-000000000001";
const account: RepositoryInput = { url, branch: "release/next", username: "fixture-owner", token: "fixture-repo-secret" };

function configuration(env: Record<string, string>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`]!;
    (result[key] ??= []).push(env[`GIT_CONFIG_VALUE_${i}`]!);
  }
  return result;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-landing-authority-"));
  roots.push(directory);
  const mirror = join(directory, "workspace.git");
  await mkdir(mirror);
  const invocations: GitInvocation[] = [];
  const lookups: string[] = [];
  let address = "93.184.216.34";
  const connector = new RepositoryConnector({
    timeoutMs: 1234, maxOutputBytes: 5678, maxRepositoryBytes: 98765,
    lookup: async host => { lookups.push(host); return [{ address, family: 4 }]; },
    execute: async invocation => { invocations.push(invocation); return { code: 0, stdout: `${head}\t${trailRef}\n` }; },
  });
  return { connector, directory, mirror, invocations, lookups, address: (next: string) => { address = next; } };
}

test("landing commands use the exact connected URL, only its branch or a trail ref, and exact leases", async () => {
  const f = await fixture();
  const branch = `refs/heads/${account.branch}`;
  const commands = [
    ["git", "ls-remote", "--refs", "--exit-code", "--", url, branch],
    ["git", "push", "--porcelain", "--no-verify", `--force-with-lease=${branch}:${old}`, "--", url, `${head}:${branch}`],
    ["git", "push", "--porcelain", "--no-verify", `--force-with-lease=${trailRef}:`, "--", url, `${head}:${trailRef}`],
    ["git", "push", "--porcelain", "--no-verify", `--force-with-lease=${trailRef}:${head}`, "--", url, `:${trailRef}`],
  ];
  for (const command of commands) {
    const result = await f.connector.command(account, f.directory, command);
    expect(result.stderr).toBe("");
    expect(f.invocations.at(-1)!.args).toEqual(["--git-dir", f.mirror, ...command.slice(1)]);
    expect(f.invocations.at(-1)!.directory).toBe(f.mirror);
  }
  expect(f.invocations).toHaveLength(commands.length);
});

test("each operation resolves fresh public DNS and passes credentials only through constrained process config", async () => {
  const f = await fixture();
  const command = ["git", "ls-remote", "--refs", "--exit-code", "--", url, `refs/heads/${account.branch}`];
  await f.connector.command(account, f.directory, command);
  f.address("93.184.216.35");
  await f.connector.command(account, f.directory, command);
  expect(f.lookups).toEqual(["forge.example.com", "forge.example.com"]);
  const [first, second] = f.invocations;
  const firstConfig = configuration(first!.env);
  const secondConfig = configuration(second!.env);
  expect(firstConfig["http.curloptResolve"]?.at(-1)).toBe("forge.example.com:443:93.184.216.34");
  expect(secondConfig["http.curloptResolve"]?.at(-1)).toBe("forge.example.com:443:93.184.216.35");
  expect(secondConfig["http.extraHeader"]?.at(-1)).toBe(
    `Authorization: Basic ${Buffer.from(`${account.username}:${account.token}`).toString("base64")}`,
  );
  expect(secondConfig["http.followRedirects"]).toEqual(["false"]);
  expect(secondConfig["http.proxy"]).toEqual([""]);
  expect(secondConfig["http.sslVerify"]).toEqual(["true"]);
  expect(secondConfig["protocol.allow"]).toEqual(["never"]);
  expect(secondConfig["core.hooksPath"]).toEqual(["/dev/null"]);
  expect(secondConfig["credential.helper"]).toEqual([""]);
  expect(second!.env.GIT_ALLOW_PROTOCOL).toBe("https");
  expect(second!.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(second!.env.GIT_TERMINAL_PROMPT).toBe("0");
  expect(Object.keys(second!.env).filter(key => /^(?:HOME|SSH_AUTH_SOCK|.*proxy|OPENAI_API_KEY|EPHYRA_SESSION_KEY)$/i.test(key))).toEqual([]);
  expect(JSON.stringify(f.invocations.map(invocation => invocation.args))).not.toContain(account.token!);
  expect(JSON.stringify(f.invocations.map(invocation => invocation.args))).not.toContain("Authorization");
  expect(second).toMatchObject({ timeoutMs: 1234, maxOutputBytes: 5678, maxRepositoryBytes: 98765 });
  expect(await readdir(f.mirror)).toEqual([]);
  f.address("127.0.0.1");
  await expect(f.connector.command(account, f.directory, command)).rejects.toMatchObject({ code: "private_destination" });
  expect(f.invocations).toHaveLength(2);
});

test("another URL, branch, unpinned source or malformed lease never reaches Git", async () => {
  const f = await fixture();
  const branch = `refs/heads/${account.branch}`;
  const push = ["git", "push", "--porcelain", "--no-verify"];
  const rejected = [
    ["git", "ls-remote", "--refs", "--exit-code", "--", "https://other.example.com/team/application.git", branch],
    ["git", "ls-remote", "--refs", "--exit-code", "--", url, "refs/heads/main"],
    [...push, "--", url, `${head}:${branch}`],
    [...push, `--force-with-lease=${branch}:${old}`, "--", url, `${head}:refs/heads/main`],
    [...push, `--force-with-lease=${branch}:not-an-oid`, "--", url, `${head}:${branch}`],
    [...push, `--force-with-lease=${branch}:${old}`, "--", url, `HEAD:${branch}`],
    [...push, `--force-with-lease=${branch}:${old}`, "--", url, `${"b".repeat(64)}:${branch}`],
    [...push, `--force-with-lease=${branch}:${old}`, "--", url, `:${branch}`],
    ["git", "ls-remote", "--refs", "--exit-code", "--", url, "refs/heads/ephyra/nearby-name"],
  ];
  for (const command of rejected) await expect(f.connector.command(account, f.directory, command)).rejects.toMatchObject({ code: "repository_command" });
  expect(f.invocations).toHaveLength(0);
});

test("helper overrides, unbounded options and filesystem-writing Git options are refused", async () => {
  const f = await fixture();
  const branch = `refs/heads/${account.branch}`;
  const suffix = ["--", url, `${head}:${branch}`];
  const push = ["git", "push", "--porcelain", "--no-verify"];
  const lease = `--force-with-lease=${branch}:${old}`;
  for (const command of [
    [...push, "--receive-pack=/tmp/helper", lease, ...suffix],
    [...push, "--exec=/tmp/helper", lease, ...suffix],
    [...push, "--force", lease, ...suffix],
    [...push, "--mirror", lease, ...suffix],
    [...push, "--all", lease, ...suffix],
    [...push, "--delete", lease, ...suffix],
    [...push, "--recurse-submodules=on-demand", lease, ...suffix],
    ["git", "ls-remote", "--refs", "--exit-code", "--upload-pack=/tmp/helper", "--", url, branch],
    ["git", "show", "--output=/tmp/owned", head],
    ["git", "diff", "--no-index", "--output=/tmp/owned", "/etc/passwd", "/tmp/input"],
    ["git", "diff", "--ext-diff", old, head],
    ["git", "-c", "core.sshCommand=helper", "show", head],
    ["git", "fetch", "--", url, branch],
  ]) await expect(f.connector.command(account, f.directory, command)).rejects.toMatchObject({ code: "repository_command" });
  expect(f.invocations).toHaveLength(0);
});

test("allowed local object operations retain pinned OIDs and allow LF only in revert message data", async () => {
  const f = await fixture();
  const message = `Revert landing ${head}\n\nEphyra-Revert-Of: ${head}`;
  const command = ["git", "-c", "user.name=ephyra", "-c", "user.email=ephyra@localhost", "commit-tree", old, "-p", head, "-m", message];
  for (const argv of [
    ["git", "show", "-s", "--format=%B", head],
    ["git", "rev-parse", `${old}^{tree}`],
    command,
  ]) await f.connector.command(account, f.directory, argv);
  expect(f.invocations.at(-1)!.args).toEqual(["--git-dir", f.mirror, ...command.slice(1)]);
  for (const argv of [
    ["git", "show", "-s", "--format=%B", `${head}\n-c`],
    ["git", "rev-parse", "HEAD^{tree}"],
    [...command.slice(0, -1), "unsafe\0message"],
  ]) await expect(f.connector.command(account, f.directory, argv)).rejects.toMatchObject({ code: "repository_command" });
  expect(f.invocations).toHaveLength(3);
});

test("unsafe repository destinations and credential-host changes are refused before dispatch", async () => {
  const f = await fixture();
  for (const unsafe of ["file:///tmp/repo", "https://token@forge.example.com/repo.git", "https://127.0.0.1/repo.git"]) {
    await expect(f.connector.command({ ...account, url: unsafe }, f.directory, ["git", "show", "-s", "--format=%B", head])).rejects.toThrow();
  }
  await expect(f.connector.command({ ...account, credentialHost: "other.example.com" }, f.directory,
    ["git", "show", "-s", "--format=%B", head])).rejects.toMatchObject({ code: "repository_credential_host" });
  expect(f.invocations).toHaveLength(0);
});

test("a symlinked mirror cannot redirect a connected operation to another repository", async () => {
  const f = await fixture();
  await rm(f.mirror, { recursive: true });
  const other = join(f.directory, "other.git");
  await mkdir(other);
  await symlink(other, f.mirror);
  await expect(f.connector.command(account, f.directory, ["git", "show", "-s", "--format=%B", head])).rejects.toMatchObject({ code: "repository_path" });
  expect(f.invocations).toHaveLength(0);
});

test("generated malformed object IDs cannot become mutable remote source arguments", async () => {
  const f = await fixture();
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("g", "x", "/", ":", "-"), { minLength: 1, maxLength: 80 }), async values => {
    const source = values.join("");
    await expect(f.connector.command(account, f.directory, [
      "git", "push", "--porcelain", "--no-verify", `--force-with-lease=${trailRef}:`, "--", url, `${source}:${trailRef}`,
    ])).rejects.toMatchObject({ code: "repository_command" });
  }));
  expect(f.invocations).toHaveLength(0);
});
