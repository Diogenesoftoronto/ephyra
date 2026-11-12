import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretBox } from "../auth/crypto";
import { NotOrganicSignIn } from "../auth/notorganic";
import { fakeNotOrganic } from "../auth/notorganic.fixture";
import { MemoryAuthStore } from "../auth/store";
import { MemoryAccountStore } from "./account-store";
import { Accounts } from "./accounts";
import type { RepositoryInput } from "./repository";

const DID = "did:plc:alice";
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

const git = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

/** Accounts whose repository and mirror URLs resolve to local bare repositories; tokens are recorded, never sent anywhere. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ephyra-mirrors-"));
  roots.push(root);
  const remotes: Record<string, string> = {};
  const bare = (url: string) => {
    const dir = join(root, `remote-${Object.keys(remotes).length}.git`);
    git(["init", "-q", "--bare", "-b", "main", dir]);
    remotes[url] = dir;
    return dir;
  };
  const tokens: (string | undefined)[] = [];
  const box = await SecretBox.fromBase64(Buffer.alloc(32, 7).toString("base64"));
  const fake = fakeNotOrganic({ approved: true, product: "ephyra", did: DID });
  const signIn = new NotOrganicSignIn({ issuer: "https://api.notorganic.test", authorizationUrl: "https://id.notorganic.test/authorize",
    publicOrigin: "https://ephyra.example", product: "ephyra", scopes: [] }, new MemoryAuthStore(), box, fake.fetcher);
  const data = join(root, "data");
  const service = new Accounts({ store: new MemoryAccountStore(), box, operationSecret: "fixture-secret", dataDir: data, signIn,
    repository: {
      prepare: async (input: RepositoryInput, directory: string) => {
        await mkdir(directory, { recursive: true });
        const mirror = join(directory, "workspace.git");
        git(["clone", "-q", "--bare", remotes[input.url]!, mirror]);
        return { url: input.url, branch: input.branch, head: git(["rev-parse", "main"], mirror).stdout.trim(), verifiedAt: new Date().toISOString() };
      },
      command: async (input: RepositoryInput, directory: string, argv: string[]) => {
        tokens.push(input.token);
        const args = argv.slice(1).map((a) => remotes[a] ?? a);
        return git(["--git-dir", join(directory, "workspace.git"), ...args]);
      },
    } });
  // The workspace's own repository, with one commit.
  const work = join(root, "work");
  git(["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "f"), "one");
  git(["add", "f"], work); git(["commit", "-qm", "one"], work);
  const primary = bare("https://forge.example/team/app.git");
  git(["push", "-q", primary, "main"], work);
  const connected = await service.saveRepository(DID, { expectedVersion: 0, url: "https://forge.example/team/app.git", branch: "main" }, "repo-connect-1");
  const workspace = connected.workspaceId;
  const mirrorDir = join(data, "workspaces", workspace, "workspace.git");
  const land = async (content: string) => {
    await writeFile(join(work, "f"), content);
    git(["commit", "-qam", content], work);
    git(["push", "-q", primary, "main"], work);
    const oid = git(["rev-parse", "HEAD"], work).stdout.trim();
    git(["--git-dir", service.directory(workspace) + "/workspace.git", "fetch", "-q", primary, "+main:main"]);
    return oid;
  };
  return { service, workspace, bare, land, tokens, mirrorDir, work, git };
}

test("mirrors are validated: HTTPS only, no Radicle, Tangled, Codeberg or the repository itself, at most five", async () => {
  const f = await fixture();
  const refuse = async (url: string, message: RegExp) => {
    const s = await f.service.settings(DID);
    await expect(f.service.saveMirror(DID, { expectedVersion: s.version, url }, `m-${crypto.randomUUID()}`)).rejects.toThrow(message);
  };
  await refuse("rad:zWqAfh1Dtwr2gByC8Ln3EpW5jxv1", /Radicle/);
  await refuse("https://tangled.org/alice.example/app", /Tangled/);
  await refuse("https://codeberg.org/team/app", /Codeberg/);
  await refuse("https://forge.example/team/app.git", /own repository/);
  await refuse("http://github.com/team/app", /HTTPS/);
  let version = (await f.service.settings(DID)).version;
  for (let i = 0; i < 5; i++)
    version = (await f.service.saveMirror(DID, { expectedVersion: version, url: `https://github.com/team/app${i}` }, `m-add-${i}0000`)).version;
  await refuse("https://github.com/team/app9", /five/);
  const settings = await f.service.settings(DID);
  expect(settings.mirrors).toHaveLength(5);
  expect(JSON.stringify(settings)).not.toContain("token");
});

test("after a landing, mirrors that are behind move to the new commit, a diverged one is left alone, and results are recorded", async () => {
  const f = await fixture();
  const behind = f.bare("https://github.com/team/app-mirror.git");
  const diverged = f.bare("https://gitlab.com/team/app-mirror.git");
  const empty = f.bare("https://git.example.org/team/app-mirror");
  f.git(["push", "-q", behind, "main"], f.work);
  f.git(["push", "-q", diverged, "main"], f.work);
  const other = join(f.work, "..", "other");
  f.git(["clone", "-q", diverged, other]);
  await writeFile(join(other, "g"), "theirs"); f.git(["add", "g"], other); f.git(["commit", "-qm", "theirs"], other); f.git(["push", "-q"], other);
  let s = await f.service.settings(DID);
  s = await f.service.saveMirror(DID, { expectedVersion: s.version, url: "https://github.com/team/app-mirror", token: "gh-mirror-secret" }, "mirror-add-1");
  s = await f.service.saveMirror(DID, { expectedVersion: s.version, url: "https://gitlab.com/team/app-mirror" }, "mirror-add-2");
  s = await f.service.saveMirror(DID, { expectedVersion: s.version, url: "https://git.example.org/team/app-mirror" }, "mirror-add-3");
  const oid = await f.land("two");
  await f.service.pushMirrors(DID, f.workspace, { newOid: oid });
  expect(f.git(["rev-parse", "main"], behind).stdout.trim()).toBe(oid);
  expect(f.git(["rev-parse", "main"], empty).stdout.trim()).toBe(oid);
  expect(f.git(["rev-parse", "main"], diverged).stdout.trim()).not.toBe(oid);
  const after = await f.service.settings(DID);
  const by = Object.fromEntries(after.mirrors!.map((m) => [m.host, m.last]));
  expect(by["github.com"]).toMatchObject({ status: "ok", commit: oid });
  expect(by["git.example.org"]).toMatchObject({ status: "ok", commit: oid });
  expect(by["gitlab.com"]).toMatchObject({ status: "failed", detail: expect.stringContaining("left as it is") });
  expect(f.tokens).toContain("gh-mirror-secret");
  expect(JSON.stringify(after)).not.toContain("gh-mirror-secret");
});

test("removing a mirror drops its sealed token, and nothing is pushed when no mirror is listed", async () => {
  const f = await fixture();
  let s = await f.service.settings(DID);
  s = await f.service.saveMirror(DID, { expectedVersion: s.version, url: "https://github.com/team/x", token: "t-123456789" }, "mirror-add-x");
  s = await f.service.removeMirror(DID, { expectedVersion: s.version, id: s.mirrors![0]!.id }, "mirror-remove-x");
  expect(s.mirrors).toEqual([]);
  const before = f.tokens.length;
  await f.service.pushMirrors(DID, f.workspace, { newOid: "a".repeat(40) });
  expect(f.tokens.length).toBe(before);
});
