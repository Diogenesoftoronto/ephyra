import { spawn } from "node:child_process";
import { resolveTxt } from "node:dns/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isAtprotoDid, isAtprotoHandle, isRadicleNodeId, parseRepositoryAddress, radicleCloneArguments,
  RepositoryAddressError, type ForgeRepositorySource, type RepositoryAddress,
} from "@ephyra/forge";
import {
  ConnectionError, createPublicHttpsFetch, parsePublicHttps, resolvePublicHttps,
  type PublicLookup,
} from "./network.ts";
import {
  normalizeRepositoryInput, RepositoryConnector, type RepositoryConnection, type RepositoryInput,
} from "./repository.ts";

export type ForgeRepositoryInput = RepositoryInput & { credentialHost?: string };
export type ForgeResolution = { url: string; forge: ForgeRepositorySource };
export type ForgeConnection = RepositoryConnection & { forge: ForgeRepositorySource };
export type NativeInvocation = {
  program: "rad" | "git"; args: string[]; env: Record<string, string>; cwd: string; directory: string;
  timeoutMs: number; maxOutputBytes: number; maxRepositoryBytes: number; stdin?: string;
};
type NativeResult = { code: number; stdout: string };
export type NativeProcess = { done: Promise<NativeResult>; stop(): Promise<void> };
export type NativeCommands = { run(input: NativeInvocation): Promise<NativeResult>; start(input: NativeInvocation): Promise<NativeProcess> };
export type NativeCleanupReceipt = { repositoryId: string; nodeStopped: boolean; stagingRemoved: boolean };
export type ForgeRepositoryOptions = {
  https?: Pick<RepositoryConnector, "prepare" | "discover">;
  lookup?: PublicLookup;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveTxt?: (name: string) => Promise<string[][]>;
  commands?: NativeCommands;
  now?: () => Date;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxRepositoryBytes?: number;
  /** Called only after canonical identity resolution. The caller binds this provider to its account. */
  credentials?: (context: { input: ForgeRepositoryInput; repository: ForgeResolution }) => Promise<
    { host: string; username?: string; token: string } | undefined
  >;
  /** May provision only this fresh private RAD_HOME with an account-specific identity. Never return a global profile path. */
  provisionRadicleProfile?: (context: { input: ForgeRepositoryInput; repositoryId: string; radHome: string }) => Promise<
    { provisioned: boolean; passphrase?: string; seeds?: string[] }
  >;
  onNativeCleanup?: (receipt: NativeCleanupReceipt) => void;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionError("repository_metadata", "Repository metadata is invalid.");
  return value as Record<string, unknown>;
};
const metadataError = () => new ConnectionError("repository_identity", "The repository identity could not be verified. Check its exact address.");
async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectionError("repository_timeout", "Repository identity resolution timed out.")), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
const normalizeBranch = (branch: string) => normalizeRepositoryInput({ url: "https://radicle.dev/repository", branch }).branch;
const canonicalOrigin = (value: string): string => {
  const url = parsePublicHttps(value.includes("://") ? value : `https://${value}`);
  if (url.pathname !== "/" || url.search) throw new ConnectionError("invalid_credential", "Bind repository credentials to an HTTPS host, without a path.");
  return url.origin;
};

async function sizeOf(directory: string, limit: number, rejectLinks = false): Promise<number> {
  let total = 0;
  async function visit(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isSymbolicLink() && rejectLinks) throw new ConnectionError("repository_path", "A native repository contains an unsafe filesystem link.");
      if (item.isDirectory()) await visit(child);
      else if (item.isFile()) total += (await lstat(child)).size;
      if (total > limit) return;
    }
  }
  await visit(directory);
  return total;
}

/** The foreground node and its descendants share a bounded process group; stderr is never returned. */
async function startNative(input: NativeInvocation): Promise<NativeProcess> {
  const child = spawn(input.program, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  let failure: ConnectionError | undefined;
  let stdout = "";
  let outputBytes = 0;
  let measuring = false;
  const kill = () => {
    if (!exited && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  };
  const fail = (error: ConnectionError) => { failure ??= error; kill(); };
  const timer = setTimeout(() => fail(new ConnectionError("repository_timeout", "The native repository connection timed out.")), input.timeoutMs);
  const meter = setInterval(() => {
    if (measuring || exited) return;
    measuring = true;
    void sizeOf(input.directory, input.maxRepositoryBytes).then((size) => {
      if (size > input.maxRepositoryBytes) fail(new ConnectionError("repository_too_large", "The repository exceeds the connection size limit."));
    }).catch(() => undefined).finally(() => { measuring = false; });
  }, 250);
  const collect = (data: Buffer, keep: boolean) => {
    outputBytes += data.byteLength;
    if (outputBytes > input.maxOutputBytes) fail(new ConnectionError("repository_output_limit", "The native command exceeded its output limit."));
    else if (keep) stdout += data.toString();
  };
  child.stdout.on("data", (data: Buffer) => collect(data, true));
  child.stderr.on("data", (data: Buffer) => collect(data, false));
  child.stdin.on("error", () => undefined);
  child.stdin.end(input.stdin);
  const done = new Promise<NativeResult>((done, reject) => {
    child.once("error", () => {
      failure ??= new ConnectionError(`${input.program === "rad" ? "radicle" : "git"}_unavailable`,
        `${input.program === "rad" ? "The native Radicle CLI" : "Git"} could not be started on this server.`);
    });
    child.once("close", (code) => {
      exited = true;
      clearTimeout(timer);
      clearInterval(meter);
      if (failure) reject(failure); else done({ code: code ?? 1, stdout });
    });
  });
  void done.catch(() => undefined);
  return { done, async stop() { kill(); await done.catch(() => undefined); } };
}
export const nativeCommands: NativeCommands = {
  run: async (input) => (await startNative(input)).done,
  start: startNative,
};

function nativeEnvironment(home: string, radHome: string, passphrase?: string): Record<string, string> {
  const config = [
    ["credential.helper", ""], ["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"],
    ["protocol.allow", "never"], ["protocol.file.allow", "always"], ["protocol.rad.allow", "always"],
    ["http.proxy", ""], ["fetch.fsckObjects", "true"], ["transfer.fsckObjects", "true"],
    ["fetch.uriprotocols", ""], ["gc.auto", "0"], ["maintenance.auto", "false"],
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, RAD_HOME: radHome, NO_COLOR: "1", TERM: "dumb", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: "file:rad",
  };
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key!; env[`GIT_CONFIG_VALUE_${index}`] = value!; });
  if (passphrase !== undefined) env.RAD_PASSPHRASE = passphrase;
  return env;
}

/** Native metadata resolution; all HTTPS Git transfers delegate to the constrained existing connector. */
export class ForgeRepositoryConnector {
  private readonly https: Pick<RepositoryConnector, "prepare" | "discover">;
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(private readonly options: ForgeRepositoryOptions = {}) {
    this.https = options.https ?? new RepositoryConnector(options);
  }
  async resolve(input: Pick<ForgeRepositoryInput, "url" | "username" | "token" | "credentialHost">): Promise<ForgeResolution> {
    try {
      const address = parseRepositoryAddress(input.url);
      if (address.kind === "radicle") return {
        url: address.repositoryId, forge: { kind: address.kind, source: address.source, repositoryId: address.repositoryId },
      };
      if (address.kind !== "tangled") {
        parsePublicHttps(address.cloneUrl);
        return { url: address.cloneUrl, forge: { kind: address.kind, source: address.source, cloneUrl: address.cloneUrl } };
      }
      return await this.tangled(address);
    } catch (error) { throw this.error(error); }
  }
  async discover(input: Omit<ForgeRepositoryInput, "branch">): Promise<string> {
    try {
      const resolved = await this.resolve(input);
      if (resolved.forge.kind === "radicle") return await this.radicle({ ...input, branch: "main" }, undefined);
      return await this.https.discover(await this.transport({ ...input, branch: "main" }, resolved));
    } catch (error) { throw this.error(error); }
  }
  prepare(input: ForgeRepositoryInput, directory: string): Promise<ForgeConnection> {
    const key = resolve(directory);
    const next = (this.chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      try {
        const resolved = await this.resolve(input);
        if (resolved.forge.kind === "radicle") {
          const connected = await this.radicle(input, key);
          return { ...connected, forge: resolved.forge };
        }
        const connected = await this.https.prepare(await this.transport(input, resolved), key);
        return { ...connected, url: resolved.url, forge: resolved.forge };
      } catch (error) { throw this.error(error); }
    });
    this.chains.set(key, next);
    void next.catch(() => undefined).finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }
  private error(error: unknown): ConnectionError {
    if (error instanceof ConnectionError) return error;
    if (error instanceof RepositoryAddressError) return new ConnectionError(error.code, error.message);
    return new ConnectionError("repository_failed", "The repository connection could not be completed.");
  }
  private async transport(input: ForgeRepositoryInput, repository: ForgeResolution): Promise<RepositoryInput> {
    const url = repository.forge.cloneUrl!;
    const provided = await this.options.credentials?.({ input, repository });
    const token = provided?.token ?? input.token;
    const username = provided?.username ?? input.username;
    const binding = provided?.host ?? input.credentialHost;
    if (token && ((binding && canonicalOrigin(binding) !== new URL(url).origin) || (repository.forge.kind === "tangled" && !binding))) {
      throw new ConnectionError("repository_credential_host", "Bind private repository credentials to the resolved clone host before connecting.");
    }
    return normalizeRepositoryInput({ url, branch: input.branch, ...(token ? { token, username } : {}) });
  }
  private async tangled(address: Extract<RepositoryAddress, { kind: "tangled" }>): Promise<ForgeResolution> {
    const deadline = Date.now() + (this.options.timeoutMs ?? 60_000);
    const fetcher = this.options.fetch ?? createPublicHttpsFetch({ lookup: this.options.lookup, timeoutMs: 10_000, maxResponseBytes: 128_000 });
    const read = async (url: string, json = true): Promise<unknown> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ConnectionError("repository_timeout", "Repository identity resolution timed out.");
      await bounded(resolvePublicHttps(url, this.options.lookup), remaining);
      const response = await bounded(fetcher(url, {
        headers: { Accept: json ? "application/json" : "text/plain" }, signal: AbortSignal.timeout(remaining), redirect: "error",
      }), remaining);
      if (!response.ok) throw metadataError();
      const text = await bounded(response.text(), deadline - Date.now());
      if (Buffer.byteLength(text) > 128_000) throw new ConnectionError("repository_metadata_limit", "Repository metadata exceeds the size limit.");
      return json ? JSON.parse(text) : text.trim();
    };
    const document = async (did: string) => {
      if (!isAtprotoDid(did)) throw metadataError();
      const url = did.startsWith("did:plc:") ? `https://plc.directory/${did}` : `https://${did.slice(8)}/.well-known/did.json`;
      const doc = object(await read(url));
      if (doc.id !== did) throw metadataError();
      return doc;
    };
    const endpoint = (doc: Record<string, unknown>, suffix: string): string => {
      const services = Array.isArray(doc.service) ? doc.service.map(object) : [];
      const found = services.filter((item) => item.id === `${doc.id}${suffix}` || item.id === suffix);
      if (found.length !== 1 || typeof found[0]!.serviceEndpoint !== "string") throw metadataError();
      const url = parsePublicHttps(found[0]!.serviceEndpoint);
      if (url.search || url.pathname !== "/") throw metadataError();
      return url.origin;
    };
    const record = async (pds: string, did: string, collection: string, key: string) => {
      const query = new URLSearchParams({ repo: did, collection, rkey: key });
      const response = object(await read(`${pds}/xrpc/com.atproto.repo.getRecord?${query}`));
      if (response.uri !== `at://${did}/${collection}/${key}`) throw metadataError();
      const value = object(response.value);
      if (value.$type !== collection) throw metadataError();
      return value;
    };
    let owner = address.owner;
    if (!owner.startsWith("did:")) {
      if (!isAtprotoHandle(owner)) throw metadataError();
      parsePublicHttps(`https://${owner}`);
      let txt: string[][] = [];
      try { txt = await bounded((this.options.resolveTxt ?? resolveTxt)(`_atproto.${owner}`), deadline - Date.now()); }
      catch (error) {
        if (error instanceof ConnectionError) throw error;
        // HTTPS handle resolution is the second standard method.
      }
      const candidates = [...new Set(txt.map((item) => item.join("")).filter((item) => item.startsWith("did=")).map((item) => item.slice(4)))];
      if (candidates.length > 1) throw metadataError();
      owner = candidates[0] ?? String(await read(`https://${owner}/.well-known/atproto-did`, false));
    }
    const ownerDoc = await document(owner);
    if (!address.owner.startsWith("did:") &&
      (!Array.isArray(ownerDoc.alsoKnownAs) || !ownerDoc.alsoKnownAs.includes(`at://${address.owner}`))) throw metadataError();
    const ownerPds = endpoint(ownerDoc, "#atproto_pds");
    // The old bare org.tangled.repo NSID is not a published current record schema. Never alias it to sh.tangled.repo.
    if (address.collection === "org.tangled.repo") {
      await record(ownerPds, owner, address.collection, address.recordKey);
      throw new ConnectionError("tangled_schema_unverified",
        "This Tangled record schema is not supported. Use its current repository page or manifest AT URI.");
    }
    let repositoryId = owner;
    if (address.collection === "org.tangled.repo.declaration") {
      const declaration = await record(ownerPds, owner, address.collection, address.recordKey);
      if (typeof declaration.repo !== "string" || !isAtprotoDid(declaration.repo)) throw metadataError();
      repositoryId = declaration.repo;
    }
    const repoDoc = repositoryId === owner ? ownerDoc : await document(repositoryId);
    const knot = endpoint(repoDoc, "#tangled_knot");
    if (endpoint(repoDoc, "#atproto_pds") !== knot) throw metadataError();
    const manifest = await record(knot, repositoryId, "org.tangled.repo.manifest", "self");
    const claim = object(manifest.declaration);
    if (typeof claim.owner !== "string" || !isAtprotoDid(claim.owner) || typeof claim.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(claim.name)) throw metadataError();
    if (address.collection === "org.tangled.repo.declaration") {
      if (claim.owner !== owner || claim.name.toLowerCase() !== address.recordKey) throw metadataError();
    } else {
      const declaration = await record(endpoint(await document(claim.owner), "#atproto_pds"), claim.owner,
        "org.tangled.repo.declaration", claim.name.toLowerCase());
      if (declaration.repo !== repositoryId) throw metadataError();
      owner = claim.owner;
    }
    const cloneUrl = `${knot}/${repositoryId}`;
    await resolvePublicHttps(cloneUrl, this.options.lookup);
    return { url: `at://${repositoryId}/org.tangled.repo.manifest/self`,
      forge: { kind: "tangled", source: address.source, repositoryId, owner, cloneUrl } };
  }

  private async radicle(input: ForgeRepositoryInput, directory: undefined): Promise<string>;
  private async radicle(input: ForgeRepositoryInput, directory: string): Promise<RepositoryConnection>;
  private async radicle(input: ForgeRepositoryInput, directory: string | undefined): Promise<string | RepositoryConnection> {
    const address = parseRepositoryAddress(input.url);
    if (address.kind !== "radicle") throw metadataError();
    const repositoryId = address.repositoryId;
    if ((input.token || input.username) && !this.options.provisionRadicleProfile) {
      throw new ConnectionError("radicle_identity_required", "Private Radicle access requires an account-specific native identity on this server.");
    }
    const branch = normalizeBranch(input.branch);
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(directory ?? tmpdir(), ".ephyra-radicle-"));
    const home = join(staging, "home");
    const radHome = join(home, ".radicle");
    await mkdir(radHome, { recursive: true, mode: 0o700 });
    const commands = this.options.commands ?? nativeCommands;
    const deadline = Date.now() + (this.options.timeoutMs ?? 120_000);
    const limit = this.options.maxRepositoryBytes ?? 512_000_000;
    let node: NativeProcess | undefined;
    let nodeStopped = true;
    let removed = false;
    try {
      const profile = await this.options.provisionRadicleProfile?.({ input, repositoryId, radHome });
      const env = nativeEnvironment(home, radHome, profile?.passphrase);
      const invoke = (program: NativeInvocation["program"], args: string[], stdin?: string): NativeInvocation => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) throw new ConnectionError("repository_timeout", "The native repository connection timed out.");
        return { program, args, env, cwd: staging, directory: directory ?? staging, timeoutMs, maxOutputBytes: this.options.maxOutputBytes ?? 256_000,
          maxRepositoryBytes: limit, ...(stdin !== undefined ? { stdin } : {}) };
      };
      const run = async (program: NativeInvocation["program"], args: string[], stdin?: string) => {
        const result = await commands.run(invoke(program, args, stdin));
        if (result.code !== 0) throw new ConnectionError("repository_native",
          "The native repository command failed. Check native service availability and account access.");
        if (Buffer.byteLength(result.stdout) > (this.options.maxOutputBytes ?? 256_000)) {
          throw new ConnectionError("repository_output_limit", "Native output exceeds the limit.");
        }
        return result.stdout.trim();
      };
      if (!profile?.provisioned) await run("rad", ["auth", "--alias", "ephyra-reader", "--stdin"], "\n");
      node = await commands.start(invoke("rad", ["node", "start", "--foreground"]));
      nodeStopped = false;
      let nodeEnded = false;
      void node.done.then(() => { nodeEnded = true; }, () => { nodeEnded = true; });
      let ready = false;
      for (let i = 0; i < 40 && !nodeEnded; i++) {
        const status = await commands.run(invoke("rad", ["node", "status", "--only", "nid"]));
        if (status.code === 0 && isRadicleNodeId(status.stdout.trim())) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ready) throw new ConnectionError("radicle_node_unavailable", "The isolated Radicle node could not start.");
      const native = join(staging, "repository.git");
      const seeds = profile?.seeds ?? (address.seed ? [address.seed] : []);
      await run("rad", radicleCloneArguments(repositoryId, native, deadline - Date.now(), seeds));
      if ((await sizeOf(directory ?? staging, limit, true)) > limit) {
        throw new ConnectionError("repository_too_large", "The native repository exceeds the size limit.");
      }
      try {
        if ((await readFile(join(native, "objects/info/alternates"), "utf8")).trim()) {
          throw new ConnectionError("repository_path", "Native object alternates are not accepted.");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const payload = object(JSON.parse(await run("rad", ["inspect", repositoryId, "--payload"])));
      const defaultBranch = object(payload["xyz.radicle.project"]).defaultBranch;
      if (typeof defaultBranch !== "string") throw new ConnectionError("repository_branch", "Radicle did not supply a verifiable default branch.");
      const discovered = normalizeBranch(defaultBranch);
      const defaultHead = await run("git", ["--git-dir", native, "rev-parse", "--verify", `refs/heads/${discovered}^{commit}`]);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(defaultHead)) {
        throw new ConnectionError("repository_head", "The native default branch did not resolve to a commit.");
      }
      if (!directory) return discovered;
      const final = join(directory, "workspace.git");
      let existing = false;
      try {
        const info = await lstat(final);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ConnectionError("repository_path", "The repository directory is unavailable.");
        existing = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const target = existing ? final : join(staging, "safe.git");
      const git = (args: string[]) => run("git", ["--git-dir", target, ...args]);
      if (existing) {
        if (await git(["config", "--get", "ephyra.source"]) !== repositoryId) {
          throw new ConnectionError("repository_changed", "A different repository needs a new workspace.");
        }
      } else {
        const format = await run("git", ["--git-dir", native, "rev-parse", "--show-object-format"]);
        if (!["sha1", "sha256"].includes(format)) throw metadataError();
        await run("git", ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, target]);
        await git(["config", "ephyra.source", repositoryId]);
      }
      const ref = `refs/heads/${branch}`;
      await git(["fetch", "--no-tags", "--depth=1", "--no-recurse-submodules", "--force", "--", pathToFileURL(native).href, `+${ref}:${ref}`]);
      const head = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new ConnectionError("repository_head", "The native branch did not resolve to a commit.");
      await git(["symbolic-ref", "HEAD", ref]);
      if ((await sizeOf(directory, limit, true)) > limit) throw new ConnectionError("repository_too_large", "The native repository exceeds the size limit.");
      if (!existing) await rename(target, final);
      return { url: repositoryId, branch, head, verifiedAt: (this.options.now?.() ?? new Date()).toISOString() };
    } finally {
      try {
        if (node) { await node.stop(); nodeStopped = true; }
        if (nodeStopped) { await rm(staging, { recursive: true, force: true }); removed = true; }
      } catch {
        throw new ConnectionError("radicle_cleanup",
          "Native repository cleanup could not be confirmed. The operator must inspect the isolated process.");
      }
      finally { this.options.onNativeCleanup?.({ repositoryId, nodeStopped, stagingRemoved: removed }); }
    }
  }
}
