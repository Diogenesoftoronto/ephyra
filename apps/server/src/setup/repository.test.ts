import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { ConnectionError } from "./network.ts";
import { normalizeRepositoryInput, RepositoryConnector, type GitExecutor, type GitInvocation } from "./repository.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const cloneUrl = "https://forge.example.com/team/application.git";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "ephyra-repository-test-"));
  roots.push(path);
  return path;
}

function localGit(args: string[], cwd?: string, env?: Record<string, string>) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: env ?? {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

async function fixture(format: "sha1" | "sha256" = "sha1") {
  const root = await temporary();
  const source = join(root, "source");
  await mkdir(source);
  expect(localGit(["init", "--quiet", "--initial-branch=main", "--template=", `--object-format=${format}`], source).code).toBe(0);
  await writeFile(join(source, "README.md"), "An offline fixture.\n");
  expect(localGit(["add", "README.md"], source).code).toBe(0);
  expect(localGit(["commit", "--quiet", "-m", "fixture"], source).code).toBe(0);
  const head = localGit(["rev-parse", "HEAD"], source).stdout.trim();
  const invocations: GitInvocation[] = [];
  const execute: GitExecutor = async (input) => {
    invocations.push(input);
    // Trusted test-only adapter: production input is captured first, then the remote is replaced by our local fixture.
    const args = [...input.args];
    if (args.includes("fetch") || args.includes("ls-remote")) args[args.indexOf("--") + 1] = pathToFileURL(source).href;
    return localGit(["-c", "protocol.file.allow=always", ...args], undefined, {
      ...input.env,
      GIT_ALLOW_PROTOCOL: "file",
    });
  };
  return { root, source, head, invocations, execute, directory: join(root, "workspace") };
}

function configuration(env: Record<string, string>) {
  const values: Record<string, string[]> = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`]!;
    (values[key] ??= []).push(env[`GIT_CONFIG_VALUE_${i}`]!);
  }
  return values;
}

describe("repository input validation", () => {
  test("accepts forge-independent HTTPS URLs and branch paths", () => {
    expect(
      normalizeRepositoryInput({
        url: "https://tangled.org/example.com/application",
        branch: "refs/heads/release/next",
      }),
    ).toEqual({ url: "https://tangled.org/example.com/application", branch: "release/next" });
    expect(normalizeRepositoryInput({ url: "https://seed.example.org:8443/project.git", branch: "main" }).url).toBe(
      "https://seed.example.org:8443/project.git",
    );
  });

  test("rejects embedded credentials, helper/local URLs and invalid refs", () => {
    for (const url of [
      "/tmp/repository",
      "file:///tmp/repository",
      "ssh://example.com/repo",
      "ext::sh -c evil",
      "https://token@example.com/repo",
      "https://example.com/repo?token=secret",
      "https://example.com",
    ]) {
      expect(() => normalizeRepositoryInput({ url, branch: "main" })).toThrow(ConnectionError);
    }
    for (const branch of [
      "",
      "-c",
      "--upload-pack=evil",
      "main:refs/heads/evil",
      "main\n--config=evil",
      "../main",
      "main~1",
      "main^{}",
      "main@{1}",
      "main.lock",
      ".main",
      "main//next",
      "main/",
      "main?",
      "main*",
      "main[0]",
      "main\\next",
    ]) {
      expect(() => normalizeRepositoryInput({ url: cloneUrl, branch })).toThrow(ConnectionError);
    }
    expect(() => normalizeRepositoryInput({ url: cloneUrl, branch: "main", username: "a:b", token: "ok" })).toThrow(
      ConnectionError,
    );
    expect(() => normalizeRepositoryInput({ url: cloneUrl, branch: "main", token: "secret\nheader" })).toThrow(
      ConnectionError,
    );
    expect(() => normalizeRepositoryInput({ url: cloneUrl, branch: "main", token: "fixture", credentialHost: "other.example.com" }))
      .toThrow(ConnectionError);
    expect(normalizeRepositoryInput({ url: cloneUrl, branch: "main", token: "fixture", credentialHost: "forge.example.com" }).credentialHost)
      .toBe("https://forge.example.com");
  });

  test("all accepted generated branch names remain one valid refs/heads argument", () => {
    const part = fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), { minLength: 1, maxLength: 15 })
      .map((chars) => `b${chars.join("")}`);
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 4 }), (parts) => {
        const branch = parts.join("/");
        expect(normalizeRepositoryInput({ url: cloneUrl, branch }).branch).toBe(branch);
        expect(localGit(["check-ref-format", `refs/heads/${branch}`]).code).toBe(0);
      }),
      { numRuns: 30 },
    );
  });
});

describe("repository connection", () => {
  test("negotiates SHA-256 from the selected advertised ref before creating a bare workspace", async () => {
    const f = await fixture("sha256");
    const connection = await new RepositoryConnector({ lookup: publicLookup, execute: f.execute })
      .prepare({ url: cloneUrl, branch: "main" }, f.directory);
    expect(connection.head).toBe(f.head);
    expect(connection.head).toHaveLength(64);
    expect(localGit(["--git-dir", join(f.directory, "workspace.git"), "rev-parse", "--show-object-format"]).stdout.trim()).toBe("sha256");
    const initial = f.invocations.find((item) => item.args.includes("init"))!;
    expect(initial.args).toContain("--object-format=sha256");
    expect(f.invocations.find((item) => item.args.includes("ls-remote"))!.args).toEqual([
      "ls-remote", "--refs", "--", cloneUrl, "refs/heads/main",
    ]);
  });
  test("fetches a real selected branch into a bare mirror and returns its actual commit", async () => {
    const f = await fixture();
    expect(localGit(["branch", "unselected"], f.source).code).toBe(0);
    expect(localGit(["tag", "unselected-tag"], f.source).code).toBe(0);
    const connection = await new RepositoryConnector({
      lookup: publicLookup,
      execute: f.execute,
      now: () => new Date("2026-01-01T00:00:00Z"),
    }).prepare({ url: cloneUrl, branch: "refs/heads/main" }, f.directory);
    expect(connection).toEqual({ url: cloneUrl, branch: "main", head: f.head, verifiedAt: "2026-01-01T00:00:00.000Z" });
    const bare = join(f.directory, "workspace.git");
    expect(localGit(["--git-dir", bare, "rev-parse", "--is-bare-repository"]).stdout.trim()).toBe("true");
    expect(localGit(["--git-dir", bare, "for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe("refs/heads/main");
    expect(localGit(["--git-dir", bare, "symbolic-ref", "HEAD"]).stdout.trim()).toBe("refs/heads/main");
    expect(await readdir(f.directory)).toEqual(["workspace.git"]);
  });

  test("credentials remain per-process while transport and hooks are constrained", async () => {
    const f = await fixture();
    const token = "fixture-access-token";
    await new RepositoryConnector({ lookup: publicLookup, execute: f.execute }).prepare(
      { url: cloneUrl, branch: "main", username: "fixture", token },
      f.directory,
    );
    const wire = f.invocations.find((input) => input.args.includes("fetch"))!;
    const config = configuration(wire.env);
    expect(wire.args).toContain("--depth=1");
    expect(wire.args).toContain("--no-recurse-submodules");
    expect(wire.args.slice(-2)).toEqual([cloneUrl, "+refs/heads/main:refs/heads/main"]);
    expect(config["http.curloptResolve"]).toEqual(["", "forge.example.com:443:93.184.216.34"]);
    expect(config["http.followRedirects"]).toEqual(["false"]);
    expect(config["http.proxy"]).toEqual([""]);
    expect(config["http.sslVerify"]).toEqual(["true"]);
    expect(config["http.extraHeader"]?.at(-1)).toBe(
      `Authorization: Basic ${Buffer.from(`fixture:${token}`).toString("base64")}`,
    );
    expect(config["protocol.allow"]).toEqual(["never"]);
    expect(config["credential.helper"]).toEqual([""]);
    expect(config["core.hooksPath"]).toEqual(["/dev/null"]);
    expect(config["fetch.uriprotocols"]).toEqual([""]);
    expect(wire.env.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(wire.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(wire.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(wire.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(
      Object.keys(wire.env).filter((key) =>
        /^(?:http_proxy|https_proxy|all_proxy|HOME|SSH_AUTH_SOCK|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i.test(key),
      ),
    ).toEqual([]);
    expect(JSON.stringify(f.invocations.map((item) => item.args))).not.toContain(token);
    const persisted = await readFile(join(f.directory, "workspace.git", "config"), "utf8");
    expect(persisted).toContain(cloneUrl);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain("Authorization");
  });

  test("refreshes the selected branch but refuses changed origins before fetching", async () => {
    const f = await fixture();
    const connector = new RepositoryConnector({ lookup: publicLookup, execute: f.execute });
    await connector.prepare({ url: cloneUrl, branch: "main" }, f.directory);
    await writeFile(join(f.source, "README.md"), "Updated offline fixture.\n");
    expect(localGit(["commit", "--quiet", "-am", "updated fixture"], f.source).code).toBe(0);
    const updatedHead = localGit(["rev-parse", "HEAD"], f.source).stdout.trim();
    expect((await connector.prepare({ url: cloneUrl, branch: "main" }, f.directory)).head).toBe(updatedHead);
    const before = f.invocations.filter((item) => item.args.includes("fetch")).length;
    await expect(
      connector.prepare({ url: "https://other.example.com/repo.git", branch: "main" }, f.directory),
    ).rejects.toMatchObject({ code: "repository_changed" });
    expect(f.invocations.filter((item) => item.args.includes("fetch"))).toHaveLength(before);
    expect(localGit(["--git-dir", join(f.directory, "workspace.git"), "rev-parse", "HEAD"]).stdout.trim()).toBe(
      updatedHead,
    );
  });

  test("missing branches fail without publishing a mirror or deleting unrelated files", async () => {
    const f = await fixture();
    await mkdir(f.directory);
    await writeFile(join(f.directory, "keep.txt"), "owned by coordinator");
    await expect(
      new RepositoryConnector({ lookup: publicLookup, execute: f.execute }).prepare(
        { url: cloneUrl, branch: "missing" },
        f.directory,
      ),
    ).rejects.toMatchObject({ code: "repository_fetch" });
    expect(await readdir(f.directory)).toEqual(["keep.txt"]);
  });

  test("does not touch Git for a private destination or dangerous branch", async () => {
    const root = await temporary();
    let called = false;
    const connector = new RepositoryConnector({
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      execute: async () => {
        called = true;
        return { code: 0, stdout: "" };
      },
    });
    await expect(connector.prepare({ url: cloneUrl, branch: "main" }, join(root, "workspace"))).rejects.toMatchObject({
      code: "private_destination",
    });
    await expect(
      connector.prepare({ url: cloneUrl, branch: "--upload-pack=evil" }, join(root, "workspace")),
    ).rejects.toMatchObject({ code: "invalid_branch" });
    expect(called).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  test("redacts executor failures and removes only its staging attempt", async () => {
    const f = await fixture();
    const execute: GitExecutor = async (input) => {
      if (input.args.includes("fetch")) throw new Error("Authorization: Basic fixture-private-key");
      return f.execute(input);
    };
    await expect(
      new RepositoryConnector({ lookup: publicLookup, execute }).prepare(
        { url: cloneUrl, branch: "main", token: "fixture-private-key" },
        f.directory,
      ),
    ).rejects.toMatchObject({
      code: "repository_failed",
      message: "The repository connection could not be completed.",
    });
    expect(await readdir(f.directory)).toEqual([]);
  });

  test("rejects an unverifiable fetched head", async () => {
    const f = await fixture();
    const execute: GitExecutor = async (input) =>
      input.args.includes("rev-parse") ? { code: 0, stdout: "unverified\n" } : f.execute(input);
    await expect(
      new RepositoryConnector({ lookup: publicLookup, execute }).prepare(
        { url: cloneUrl, branch: "main" },
        f.directory,
      ),
    ).rejects.toMatchObject({ code: "repository_head" });
    expect(await readdir(f.directory)).toEqual([]);
  });

  test("serializes same-directory connections so they cannot race initialization", async () => {
    const f = await fixture();
    const connector = new RepositoryConnector({ lookup: publicLookup, execute: f.execute });
    const results = await Promise.all([
      connector.prepare({ url: cloneUrl, branch: "main" }, f.directory),
      connector.prepare({ url: cloneUrl, branch: "main" }, f.directory),
    ]);
    expect(results.map((result) => result.head)).toEqual([f.head, f.head]);
    expect(f.invocations.filter((item) => item.args.includes("init"))).toHaveLength(1);
  });
});


test("default branch discovery follows the advertised branch without guessing main", async () => {
  const f = await fixture();
  expect(localGit(["branch", "-m", "main", "trunk"], f.source).code).toBe(0);
  const connector = new RepositoryConnector({ lookup: publicLookup, execute: f.execute });
  expect(await connector.discover({ url: cloneUrl })).toBe("trunk");
  const invocation = f.invocations.find((item) => item.args.includes("ls-remote"))!;
  expect(invocation.args).toEqual(["ls-remote", "--symref", "--", cloneUrl, "HEAD"]);
  expect(configuration(invocation.env)["http.followRedirects"]).toEqual(["false"]);
});

test("default branch discovery refuses private targets and malformed advertised refs", async () => {
  let calls = 0;
  const blocked = new RepositoryConnector({ lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    execute: async () => { calls++; return { code: 0, stdout: "" }; } });
  await expect(blocked.discover({ url: cloneUrl })).rejects.toMatchObject({ code: "private_destination" });
  expect(calls).toBe(0);
  const malformed = new RepositoryConnector({ lookup: publicLookup,
    execute: async () => ({ code: 0, stdout: "ref: refs/heads/--upload-pack=evil\tHEAD\n" }) });
  await expect(malformed.discover({ url: cloneUrl })).rejects.toMatchObject({ code: "invalid_branch" });
});
