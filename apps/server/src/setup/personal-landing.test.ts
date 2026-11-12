import { expect, test } from "bun:test";
import type { ForgeAdapter } from "@ephyra/core";
import { MemoryOperationLedger, type HostedPullOptions } from "@ephyra/forge";
import type { ServerContext } from "../wiring/context.ts";
import type { GitProbeCatalog } from "../wiring/probes.ts";
import type { Accounts } from "./accounts.ts";
import { personalLanding } from "./personal-landing.ts";

type Repo = { url: string; branch: string; credentialConfigured: boolean; forge?: { kind: string; source: string; cloneUrl?: string } };

async function landingFor(initial: Repo) {
  let repository: Repo = initial;
  const built: HostedPullOptions[] = [];
  const tokenCalls: unknown[] = [];
  const accounts = {
    record: async () => ({ settings: { workspaceId: "ws-1", repository } }),
    repositoryToken: async (_did: string, _ws: string, expected: unknown) => {
      tokenCalls.push(expected);
      if (expected !== repository) throw new Error("The repository authority changed.");
      return "repo-token";
    },
    repositoryCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    refreshRepository: async () => "a".repeat(40),
  } as unknown as Accounts;
  const factory = personalLanding({ accounts, did: "did:alice", workspace: "ws-1",
    hosted: (options) => { built.push(options); return { name: options.provider } as unknown as ForgeAdapter; } });
  const ctx = { repo: { mirrorDir: "/tmp/mirror" } } as unknown as ServerContext;
  const landing = await factory({ ctx, ledger: new MemoryOperationLedger(), probes: {} as GitProbeCatalog,
    runProbe: async () => { throw new Error("unused"); }, telemetry: null });
  return { landing, built, tokenCalls, change: (next: Repo) => { repository = next; } };
}

const github: Repo = { url: "https://github.com/acme/app.git", branch: "main", credentialConfigured: true,
  forge: { kind: "github", source: "https://github.com/acme/app", cloneUrl: "https://github.com/acme/app.git" } };

test("a GitHub workspace with a saved token lands pull requests through the GitHub API, beside plain pushes", async () => {
  const { landing, built } = await landingFor(github);
  expect(landing.adapters.map((a) => a.name)).toEqual(["plain-git", "github"]);
  expect(built[0]).toMatchObject({ provider: "github", apiBase: "https://api.github.com", repository: "acme/app", baseBranch: "main",
    remote: "https://github.com/acme/app.git", scope: "did:alice:ws-1", repoDir: "/tmp/mirror" });
});

test("the token is read per call and refused once the repository changes", async () => {
  const { built, change } = await landingFor(github);
  expect(await built[0]!.token()).toBe("repo-token");
  change({ ...github, branch: "release" });
  await expect(built[0]!.token()).rejects.toThrow("authority changed");
  await expect(built[0]!.authorize()).rejects.toThrow();
});

test("GitLab (including self-hosted) and Forgejo get their own APIs", async () => {
  const gitlab = await landingFor({ url: "https://git.corp.example/group/sub/app.git", branch: "refs/heads/main", credentialConfigured: true,
    forge: { kind: "gitlab", source: "https://git.corp.example/group/sub/app" } });
  expect(gitlab.built[0]).toMatchObject({ provider: "gitlab", apiBase: "https://git.corp.example/api/v4", repository: "group/sub/app",
    baseBranch: "main" });
  const forgejo = await landingFor({ url: "https://git.example.org/team/app.git", branch: "main", credentialConfigured: true,
    forge: { kind: "forgejo", source: "https://git.example.org/team/app" } });
  expect(forgejo.built[0]).toMatchObject({ provider: "forgejo", apiBase: "https://git.example.org/api/v1" });
});

test("no token, a plain Git host or Codeberg means no pull request adapter: pull_request parks instead of pushing", async () => {
  for (const repo of [
    { ...github, credentialConfigured: false },
    { url: "https://git.example.org/team/app.git", branch: "main", credentialConfigured: true, forge: { kind: "git", source: "x" } },
    { url: "https://codeberg.org/team/app.git", branch: "main", credentialConfigured: true, forge: { kind: "forgejo", source: "x" } },
  ]) {
    const { landing, built } = await landingFor(repo);
    expect(landing.adapters.map((a) => a.name)).toEqual(["plain-git"]);
    expect(built).toHaveLength(0);
  }
});
