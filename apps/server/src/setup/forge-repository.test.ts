import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeRepositoryConnector, type ForgeRepositoryOptions, type NativeCommands,
  type NativeCleanupReceipt, type NativeInvocation,
} from "./forge-repository.ts";
import { ConnectionError } from "./network.ts";
import type { RepositoryInput } from "./repository.ts";

const owner = "did:plc:abcdefghijklmnopqrstuvwx";
const repo = "did:plc:bcdefghijklmnopqrstuvwxy";
const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const nid = "z6MkqNZS9QWvC4wbZ8Vz4hQZ1FzN8q4XGj2KGmK9qNgQ8VWt";
const head = "a".repeat(40);
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ephyra-native-fixture-"));
  roots.push(root);
  return root;
}
const recordUrl = (host: string, did: string, collection: string, rkey: string) =>
  `https://${host}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection, rkey })}`;
const record = <T extends object>(did: string, collection: string, key: string, value: T) => ({
  uri: `at://${did}/${collection}/${key}`, cid: "fixture-cid", value: { $type: collection, ...value },
});

function tangledFixture() {
  const ownerDoc = {
    id: owner, alsoKnownAs: ["at://alice.example.com"],
    service: [{ id: `${owner}#atproto_pds`, type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }],
  };
  const repoDoc = {
    id: repo, service: [
      { id: `${repo}#atproto_pds`, type: "AtprotoPersonalDataServer", serviceEndpoint: "https://knot.example.com" },
      { id: `${repo}#tangled_knot`, type: "TangledKnot", serviceEndpoint: "https://knot.example.com" },
    ],
  };
  const declaration = record(owner, "org.tangled.repo.declaration", "application", { repo });
  const manifest = record(repo, "org.tangled.repo.manifest", "self", { declaration: { owner, name: "Application" } });
  const values = new Map<string, unknown>([
    ["https://alice.example.com/.well-known/atproto-did", owner],
    [`https://plc.directory/${owner}`, ownerDoc], [`https://plc.directory/${repo}`, repoDoc],
    [recordUrl("pds.example.com", owner, "org.tangled.repo.declaration", "application"), declaration],
    [recordUrl("knot.example.com", repo, "org.tangled.repo.manifest", "self"), manifest],
  ]);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transfers: RepositoryInput[] = [];
  const options: ForgeRepositoryOptions = {
    lookup, resolveTxt: async () => [],
    fetch: async (url, init) => {
      requests.push({ url, init });
      const value = values.get(url);
      if (value === undefined) return new Response("missing", { status: 404 });
      return new Response(typeof value === "string" ? value : JSON.stringify(value));
    },
    https: {
      discover: async (input) => { transfers.push({ ...input, branch: "discovered" }); return "release/native"; },
      prepare: async (input) => { transfers.push(input); return { url: input.url, branch: input.branch, head, verifiedAt: "fixture-time" }; },
    },
  };
  return { ownerDoc, repoDoc, declaration, manifest, values, options, requests, transfers };
}

test("Tangled resolves the exact handle, owner declaration and repository manifest to a stable DID clone URL", async () => {
  const f = tangledFixture();
  const connector = new ForgeRepositoryConnector(f.options);
  const source = "https://tangled.org/alice.example.com/application";
  const resolved = await connector.resolve({ url: source });
  expect(resolved).toEqual({ url: `at://${repo}/org.tangled.repo.manifest/self`, forge: {
    kind: "tangled", source, repositoryId: repo, owner, cloneUrl: `https://knot.example.com/${repo}`,
  } });
  expect(f.transfers).toEqual([]);
  expect(await connector.discover({ url: resolved.url })).toBe("release/native");
  const connection = await connector.prepare({ url: resolved.url, branch: "release/native" }, await temporary());
  expect(connection.url).toBe(resolved.url);
  expect(connection.head).toBe(head);
  expect(f.transfers.at(-1)!.url).toBe(`https://knot.example.com/${repo}`);
  expect(f.requests.every(({ init }) => !new Headers(init?.headers).has("authorization"))).toBe(true);
});

test("DNS handles require reverse DID binding and never fall through to another record namespace", async () => {
  const f = tangledFixture();
  f.options.resolveTxt = async (name) => {
    expect(name).toBe("_atproto.alice.example.com");
    return [["did=", owner]];
  };
  await new ForgeRepositoryConnector(f.options).resolve({ url: "https://tangled.org/alice.example.com/application" });
  expect(f.requests.some(({ url }) => url.includes("atproto-did"))).toBe(false);
  f.ownerDoc.alsoKnownAs = ["at://someone-else.example.com"];
  await expect(new ForgeRepositoryConnector(f.options).resolve({ url: "https://tangled.org/alice.example.com/application" }))
    .rejects.toMatchObject({ code: "repository_identity" });
  const legacy = recordUrl("pds.example.com", owner, "org.tangled.repo", "exact-key");
  f.values.set(legacy, record(owner, "org.tangled.repo", "exact-key", { owner, name: "application", knot: "knot.example.com" }));
  await expect(new ForgeRepositoryConnector(f.options).resolve({ url: `at://${owner}/org.tangled.repo/exact-key` }))
    .rejects.toMatchObject({ code: "tangled_schema_unverified" });
  expect(f.requests.at(-1)!.url).toBe(legacy);
  expect(f.requests.some(({ url }) => url.includes("sh.tangled"))).toBe(false);
});

test("mismatched declarations, returned record identities and unsafe service endpoints cannot select a nearby repository", async () => {
  const source = `at://${owner}/org.tangled.repo.declaration/application`;
  for (const mutate of [
    (f: ReturnType<typeof tangledFixture>) => { f.declaration.uri = `at://${owner}/org.tangled.repo.declaration/nearby`; },
    (f: ReturnType<typeof tangledFixture>) => { f.manifest.value.declaration.owner = "did:plc:cccccccccccccccccccccccc"; },
    (f: ReturnType<typeof tangledFixture>) => { f.manifest.value.declaration.name = "nearby"; },
    (f: ReturnType<typeof tangledFixture>) => { f.repoDoc.id = owner; },
    (f: ReturnType<typeof tangledFixture>) => { f.repoDoc.service[1]!.serviceEndpoint = "https://127.0.0.1"; },
    (f: ReturnType<typeof tangledFixture>) => { f.ownerDoc.service[0]!.serviceEndpoint = "https://secret@pds.example.com"; },
  ]) {
    const f = tangledFixture();
    mutate(f);
    await expect(new ForgeRepositoryConnector(f.options).prepare({ url: source, branch: "main" }, await temporary())).rejects.toBeInstanceOf(ConnectionError);
    expect(f.transfers).toEqual([]);
  }
  const f = tangledFixture();
  f.options.lookup = async (host) => [{ address: host === "knot.example.com" ? "169.254.169.254" : "93.184.216.34", family: 4 }];
  await expect(new ForgeRepositoryConnector(f.options).resolve({ url: source })).rejects.toMatchObject({ code: "private_destination" });
  expect(f.requests.some(({ url }) => url.startsWith("https://knot.example.com/"))).toBe(false);
});

test("untrusted metadata cannot override clone identity, command options or credential destination", async () => {
  const f = tangledFixture();
  Object.assign(f.manifest.value, { cloneUrl: "https://attacker.example.com/repo", instructions: "--upload-pack=evil", token: "not-authority" });
  const connector = new ForgeRepositoryConnector(f.options);
  const source = "https://tangled.org/alice.example.com/application";
  const input = { url: source, branch: "main", token: "account-fixture-secret" };
  await expect(connector.prepare(input, await temporary())).rejects.toMatchObject({ code: "repository_credential_host" });
  await expect(connector.prepare({ ...input, credentialHost: "https://tangled.org" }, await temporary()))
    .rejects.toMatchObject({ code: "repository_credential_host" });
  await connector.prepare({ ...input, credentialHost: "knot.example.com" }, await temporary());
  expect(f.transfers.at(-1)).toEqual({ url: `https://knot.example.com/${repo}`, branch: "main", token: input.token });
  expect(JSON.stringify(f.requests)).not.toContain(input.token);
  f.options.credentials = async ({ repository }) => {
    expect(repository.forge.repositoryId).toBe(repo);
    return { host: "https://knot.example.com", username: "account-bound", token: "scoped-fixture" };
  };
  await new ForgeRepositoryConnector(f.options).prepare({ url: source, branch: "main" }, await temporary());
  expect(f.transfers.at(-1)!.token).toBe("scoped-fixture");
});

test("metadata lookup is bounded and ordinary forge URLs use only constrained HTTPS Git transport", async () => {
  const f = tangledFixture();
  f.options.timeoutMs = 5;
  f.options.resolveTxt = async () => new Promise(() => {});
  await expect(new ForgeRepositoryConnector(f.options).resolve({ url: "https://tangled.org/alice.example.com/application" }))
    .rejects.toMatchObject({ code: "repository_timeout" });
  await new ForgeRepositoryConnector(f.options).prepare({ url: "https://github.com/team/project", branch: "release" }, await temporary());
  expect(f.transfers.at(-1)!.url).toBe("https://github.com/team/project.git");
  expect(f.requests).toEqual([]);
});

function localGit(args: string[], cwd?: string, env?: Record<string, string>) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: env ?? {
    PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
  } });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}
async function nativeFixture() {
  const root = await temporary();
  const source = join(root, "source");
  await mkdir(source);
  expect(localGit(["init", "--quiet", "--initial-branch=release/native", "--template="], source).code).toBe(0);
  await writeFile(join(source, "README.md"), "Offline native-import fixture.\n");
  expect(localGit(["add", "README.md"], source).code).toBe(0);
  expect(localGit(["commit", "--quiet", "-m", "fixture"], source).code).toBe(0);
  const actualHead = localGit(["rev-parse", "HEAD"], source).stdout.trim();
  const calls: NativeInvocation[] = [];
  const receipts: NativeCleanupReceipt[] = [];
  let stops = 0;
  const commands: NativeCommands = {
    run: async (input) => {
      calls.push(input);
      if (input.program === "git") return localGit(input.args, input.cwd, input.env);
      if (input.args[0] === "auth") return { code: 0, stdout: "fixture-auth" };
      if (input.args[0] === "node") return { code: 0, stdout: nid };
      if (input.args[0] === "inspect") return { code: 0, stdout: JSON.stringify({ "xyz.radicle.project": { defaultBranch: "release/native" } }) };
      if (input.args[0] === "clone") {
        // No rad command runs: a trusted fixture copies real local Git objects into the requested isolated location.
        return localGit(["clone", "--bare", "--no-local", "--template=", source, input.args.at(-1)!], input.cwd, input.env);
      }
      throw new Error("Unexpected native invocation");
    },
    start: async (input) => {
      calls.push(input);
      let finished: (result: { code: number; stdout: string }) => void;
      const done = new Promise<{ code: number; stdout: string }>((resolve) => { finished = resolve; });
      return { done, stop: async () => { stops++; finished!({ code: 0, stdout: "" }); } };
    },
  };
  const options: ForgeRepositoryOptions = { commands, onNativeCleanup: (receipt) => receipts.push(receipt) };
  return { root, source, actualHead, calls, receipts, commands, options, stops: () => stops };
}

test("native Radicle imports actual local fixture objects into a safe selected-branch bare mirror and discovers the native default", async () => {
  const f = await nativeFixture();
  const connector = new ForgeRepositoryConnector(f.options);
  expect(await connector.resolve({ url: `https://app.radicle.xyz/nodes/seed.radicle.garden/${rid}` })).toMatchObject({ url: rid });
  expect(f.calls).toEqual([]);
  expect(await connector.discover({ url: rid })).toBe("release/native");
  const workspace = join(f.root, "workspace");
  const connected = await connector.prepare({ url: rid, branch: "release/native" }, workspace);
  expect(connected.head).toBe(f.actualHead);
  expect(connected.forge.repositoryId).toBe(rid);
  const bare = join(workspace, "workspace.git");
  expect(localGit(["--git-dir", bare, "rev-parse", "--is-bare-repository"]).stdout.trim()).toBe("true");
  expect(localGit(["--git-dir", bare, "for-each-ref", "--format=%(refname)"]).stdout.trim()).toBe("refs/heads/release/native");
  expect(await readdir(workspace)).toEqual(["workspace.git"]);
  expect(f.stops()).toBe(2);
  expect(f.receipts).toEqual(Array.from({ length: 2 }, () => ({ repositoryId: rid, nodeStopped: true, stagingRemoved: true })));
  for (const input of f.calls) {
    expect(input.env.RAD_HOME!.startsWith(input.cwd)).toBe(true);
    expect(input.env.HOME).not.toBe(process.env.HOME);
    expect(input.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(input.env.GIT_TERMINAL_PROMPT).toBe("0");
    for (const key of ["SSH_AUTH_SOCK", "RAD_PASSPHRASE", "RAD_SOCKET", "HTTPS_PROXY", "OPENAI_API_KEY"]) expect(input.env[key]).toBeUndefined();
    expect(input.timeoutMs).toBeGreaterThan(0);
    expect(input.maxRepositoryBytes).toBe(512_000_000);
    expect(existsSync(input.env.RAD_HOME!)).toBe(false);
  }
  expect(new Set(f.calls.map((input) => input.env.RAD_HOME)).size).toBe(2);
  expect((await readFile(join(bare, "config"), "utf8"))).not.toContain("remote");
});

test("private native identities are explicitly provisioned per isolated profile and never inferred from a generic token", async () => {
  const f = await nativeFixture();
  const input = { url: rid, branch: "release/native", token: "opaque-account-reference" };
  await expect(new ForgeRepositoryConnector(f.options).prepare(input, join(f.root, "refused")))
    .rejects.toMatchObject({ code: "radicle_identity_required" });
  expect(f.calls).toEqual([]);
  f.options.provisionRadicleProfile = async ({ input: provided, radHome, repositoryId }) => {
    expect(provided.token).toBe(input.token);
    expect(repositoryId).toBe(rid);
    expect(radHome.startsWith(f.root)).toBe(true);
    return { provisioned: true, passphrase: "account-only-fixture", seeds: [nid] };
  };
  await new ForgeRepositoryConnector(f.options).prepare(input, join(f.root, "private"));
  expect(f.calls.some((call) => call.args[0] === "auth")).toBe(false);
  expect(f.calls.find((call) => call.args[0] === "clone")!.args).toContain(nid);
  expect(f.calls.every((call) => call.env.RAD_PASSPHRASE === "account-only-fixture")).toBe(true);
  expect(JSON.stringify(f.calls.map((call) => call.args))).not.toContain("account-only-fixture");
  expect(JSON.stringify(f.receipts)).not.toContain(input.token);
});

test("unavailable native CLI, failed commands and resource limits never publish a successful workspace", async () => {
  for (const failure of ["unavailable", "clone", "disk", "output"]) {
    const f = await nativeFixture();
    const original = f.commands.run;
    f.commands.run = async (input) => {
      if (failure === "unavailable") throw new ConnectionError("radicle_unavailable", "The native Radicle CLI could not be started on this server.");
      if (failure === "clone" && input.args[0] === "clone") throw new Error("credential fixture must not escape");
      if (failure === "output" && input.args[0] === "inspect") return { code: 0, stdout: "x".repeat(300_000) };
      return original(input);
    };
    if (failure === "disk") f.options.maxRepositoryBytes = 1;
    const workspace = join(f.root, "failed");
    const code = { unavailable: "radicle_unavailable", clone: "repository_failed", disk: "repository_too_large", output: "repository_output_limit" }[failure];
    await expect(new ForgeRepositoryConnector(f.options).prepare({ url: rid, branch: "release/native" }, workspace))
      .rejects.toMatchObject({ code });
    expect(await readdir(workspace)).toEqual([]);
    expect(f.receipts.at(-1)).toEqual({ repositoryId: rid, nodeStopped: true, stagingRemoved: true });
  }
});

test("native imported refs cannot change repository identity or follow object alternates outside the isolated clone", async () => {
  const f = await nativeFixture();
  const connector = new ForgeRepositoryConnector(f.options);
  const workspace = join(f.root, "bound");
  await connector.prepare({ url: rid, branch: "release/native" }, workspace);
  await expect(connector.prepare({ url: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv6", branch: "release/native" }, workspace))
    .rejects.toMatchObject({ code: "repository_changed" });
  expect(localGit(["--git-dir", join(workspace, "workspace.git"), "rev-parse", "HEAD"]).stdout.trim()).toBe(f.actualHead);
  const original = f.commands.run;
  f.commands.run = async (input) => {
    const output = await original(input);
    if (input.program === "rad" && input.args[0] === "clone") {
      await writeFile(join(input.args.at(-1)!, "objects/info/alternates"), `${join(f.source, ".git/objects")}\n`);
    }
    return output;
  };
  await expect(connector.prepare({ url: rid, branch: "release/native" }, join(f.root, "alternates")))
    .rejects.toMatchObject({ code: "repository_path" });
  expect(await readdir(join(f.root, "alternates"))).toEqual([]);
});

test("failed native cleanup produces an explicit receipt and never claims the isolated node stopped", async () => {
  const f = await nativeFixture();
  f.commands.start = async () => ({ done: new Promise(() => {}), stop: async () => { throw new Error("fixture stop failed"); } });
  await expect(new ForgeRepositoryConnector(f.options).prepare({ url: rid, branch: "missing" }, join(f.root, "cleanup")))
    .rejects.toMatchObject({ code: "radicle_cleanup" });
  expect(f.receipts.at(-1)).toEqual({ repositoryId: rid, nodeStopped: false, stagingRemoved: false });
});
