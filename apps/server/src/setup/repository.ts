// Connect a single HTTPS branch without a checkout, hooks, repository code execution, or stored credentials.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, lstat, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import {
  ConnectionError,
  parsePublicHttps,
  resolvePublicHttps,
  type PublicLookup,
  type PublicDestination,
} from "./network.ts";

export type RepositoryInput = { url: string; branch: string; username?: string; token?: string; credentialHost?: string };
export type RepositoryConnection = { url: string; branch: string; head: string; verifiedAt: string };
export type GitInvocation = {
  args: string[];
  env: Record<string, string>;
  directory: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxRepositoryBytes: number;
};
export type GitExecutor = (input: GitInvocation) => Promise<{ code: number; stdout: string }>;
export type RepositoryConnectorOptions = {
  lookup?: PublicLookup;
  execute?: GitExecutor;
  now?: () => Date;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxRepositoryBytes?: number;
};

export function normalizeRepositoryInput(input: RepositoryInput): RepositoryInput {
  const url = parsePublicHttps(input.url.trim());
  if (url.search || input.url.includes("?") || url.pathname === "/") {
    throw new ConnectionError("invalid_repository", "Enter the repository’s HTTPS clone URL without a query string.");
  }
  let branch = input.branch.trim();
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  if (
    !branch ||
    branch.length > 200 ||
    branch.startsWith("-") ||
    branch === "@" ||
    /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) {
    throw new ConnectionError("invalid_branch", "Enter a branch name such as main or release/next.");
  }
  if (
    input.username !== undefined &&
    (!input.username || input.username.length > 200 || /[:\u0000-\u001f\u007f]/.test(input.username))
  ) {
    throw new ConnectionError("invalid_credential", "The Git username is invalid.");
  }
  if (
    input.token !== undefined &&
    (!input.token || input.token.length > 8192 || /[\u0000-\u001f\u007f]/.test(input.token))
  ) {
    throw new ConnectionError("invalid_credential", "The repository access token is invalid.");
  }
  let credentialHost = input.credentialHost;
  if (credentialHost !== undefined) {
    const host = parsePublicHttps(credentialHost.includes("://") ? credentialHost : `https://${credentialHost}`);
    if (host.pathname !== "/" || host.search || host.origin !== url.origin) {
      throw new ConnectionError("repository_credential_host", "Repository credentials must match the exact HTTPS clone host.");
    }
    credentialHost = host.origin;
  }
  return { ...input, url: url.href, branch, ...(credentialHost ? { credentialHost } : {}) };
}

/** An allowlist, deliberately excluding server credentials, proxy variables and the operator's Git/SSH environment. */
function gitEnvironment(
  target: PublicDestination,
  credential: Pick<RepositoryInput, "username" | "token">,
): Record<string, string> {
  const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
  const address = target.address.family === 6 ? `[${target.address.address}]` : target.address.address;
  const values: [string, string][] = [
    ["credential.helper", ""],
    ["credential.interactive", "false"],
    ["core.askPass", "false"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["http.followRedirects", "false"],
    ["http.proxy", ""],
    ["http.sslVerify", "true"],
    ["http.cookieFile", ""],
    ["http.saveCookies", "false"],
    ["http.extraHeader", ""],
    ["http.curloptResolve", ""],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fetch.fsckObjects", "true"],
    ["transfer.fsckObjects", "true"],
    ["fetch.uriprotocols", ""],
  ];
  // A public IP literal is already pinned; curl's HOST:PORT syntax otherwise requires a DNS hostname.
  if (!isIP(hostname)) values.push(["http.curloptResolve", `${hostname}:${target.url.port || "443"}:${address}`]);
  if (credential.token) {
    const basic = Buffer.from(`${credential.username ?? "git"}:${credential.token}`).toString("base64");
    values.push(["http.extraHeader", `Authorization: Basic ${basic}`]);
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_CONFIG_COUNT: String(values.length),
    GIT_HTTP_MAX_REQUESTS: "2",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_SMART_HTTP: "1",
  };
  values.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function directoryBytes(directory: string, limit: number): Promise<number> {
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (total > limit) return;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) total += (await lstat(child)).size;
    }
  };
  await visit(directory);
  return total;
}

/** Bounded process group; stdout is returned, stderr never escapes this boundary. */
const executeGit: GitExecutor = async (input) => {
  let failure: ConnectionError | undefined;
  let stdout = "";
  let outBytes = 0;
  let errBytes = 0;
  let exited = false;
  let measuring = false;
  const child = spawn("git", input.args, { env: input.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stop = (error: ConnectionError) => {
    failure ??= error;
    if (child.pid && !exited) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timer = setTimeout(
    () => stop(new ConnectionError("repository_timeout", "The repository connection timed out.")),
    input.timeoutMs,
  );
  const meter = setInterval(() => {
    if (measuring || exited) return;
    measuring = true;
    void directoryBytes(input.directory, input.maxRepositoryBytes)
      .then((size) => {
        if (size > input.maxRepositoryBytes)
          stop(
            new ConnectionError("repository_too_large", "The repository exceeds this server’s connection size limit."),
          );
      })
      .catch(() => undefined)
      .finally(() => {
        measuring = false;
      });
  }, 250);
  child.stdout.on("data", (data: Buffer) => {
    outBytes += data.byteLength;
    if (outBytes > input.maxOutputBytes)
      stop(new ConnectionError("repository_output_limit", "The Git response exceeded the connection limit."));
    else stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    errBytes += data.byteLength;
    if (errBytes > input.maxOutputBytes)
      stop(new ConnectionError("repository_output_limit", "The Git response exceeded the connection limit."));
  });
  try {
    const code = await new Promise<number>((done, reject) => {
      child.once("error", () =>
        reject(new ConnectionError("git_unavailable", "Git could not be started on this server.")),
      );
      child.once("close", (code) => {
        exited = true;
        done(code ?? 1);
      });
    });
    if (failure) throw failure;
    if ((await directoryBytes(input.directory, input.maxRepositoryBytes)) > input.maxRepositoryBytes) {
      throw new ConnectionError("repository_too_large", "The repository exceeds this server’s connection size limit.");
    }
    return { code, stdout };
  } finally {
    exited = true;
    clearTimeout(timer);
    clearInterval(meter);
  }
};

/** Each distinct repository connection must receive its own opaque directory. Existing origins are never silently replaced. */
export class RepositoryConnector {
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(private readonly options: RepositoryConnectorOptions = {}) {}

  /** Query the advertised HEAD using the same constrained transport as fetch. No host-specific API is required. */
  async discover(input: Omit<RepositoryInput, "branch">): Promise<string> {
    const normalized = normalizeRepositoryInput({ ...input, branch: "main" });
    const target = await resolvePublicHttps(normalized.url, this.options.lookup);
    const directory = await mkdtemp(join(tmpdir(), "ephyra-discover-"));
    try {
      const result = await (this.options.execute ?? executeGit)({
        args: ["ls-remote", "--symref", "--", normalized.url, "HEAD"],
        env: gitEnvironment(target, normalized), directory,
        timeoutMs: this.options.timeoutMs ?? 30_000,
        maxOutputBytes: this.options.maxOutputBytes ?? 256_000,
        maxRepositoryBytes: this.options.maxRepositoryBytes ?? 512_000_000,
      });
      const match = /^ref: refs\/heads\/([^\r\n\t]+)\tHEAD$/m.exec(result.stdout);
      if (result.code || !match) {
        throw new ConnectionError("repository_branch", "The default branch could not be discovered. Enter its name in advanced settings.");
      }
      return normalizeRepositoryInput({ ...normalized, branch: match[1]! }).branch;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  prepare(input: RepositoryInput, directory: string): Promise<RepositoryConnection> {
    const key = resolve(directory);
    const next = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.connect(input, key));
    this.chains.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    return next;
  }

  private async connect(raw: RepositoryInput, directory: string): Promise<RepositoryConnection> {
    try {
      return await this.connectChecked(raw, directory);
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("repository_failed", "The repository connection could not be completed.");
    }
  }

  private async connectChecked(raw: RepositoryInput, directory: string): Promise<RepositoryConnection> {
    const input = normalizeRepositoryInput(raw);
    const target = await resolvePublicHttps(input.url, this.options.lookup);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const final = join(directory, "workspace.git");
    let existing = false;
    try {
      const info = await lstat(final);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new ConnectionError("repository_path", "The repository directory is unavailable.");
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const path = existing ? final : await mkdtemp(join(directory, ".connect-"));
    const env = gitEnvironment(target, input);
    const execute = this.options.execute ?? executeGit;
    const run = (args: string[]) =>
      execute({
        args,
        env,
        directory: path,
        timeoutMs: this.options.timeoutMs ?? 60_000,
        maxOutputBytes: this.options.maxOutputBytes ?? 256_000,
        maxRepositoryBytes: this.options.maxRepositoryBytes ?? 512_000_000,
      });
    const git = (args: string[]) => run(["--git-dir", path, ...args]);
    try {
      const ref = `refs/heads/${input.branch}`;
      if ((await run(["check-ref-format", ref])).code !== 0) {
        throw new ConnectionError("invalid_branch", "The branch name is not valid.");
      }
      if (!existing) {
        // Git cannot fetch SHA-256 objects into a SHA-1 repository. The selected ref's advertised OID
        // identifies its object format before initialization; the subsequent fetch verifies the objects.
        const advertised = await run(["ls-remote", "--refs", "--", input.url, ref]);
        const heads = advertised.stdout.trim().split("\n").map((line) => line.split("\t"))
          .filter((parts) => parts.length === 2 && parts[1] === ref);
        const oid = heads[0]?.[0];
        if (advertised.code !== 0 || heads.length !== 1 || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) {
          throw new ConnectionError("repository_fetch", "The selected repository branch could not be verified before fetching.");
        }
        const format = oid.length === 64 ? "sha256" : "sha1";
        if ((await run(["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, path])).code !== 0) {
          throw new ConnectionError("repository_init", "The repository workspace could not be created.");
        }
        if ((await git(["remote", "add", "origin", input.url])).code !== 0) {
          throw new ConnectionError("repository_init", "The repository connection could not be recorded.");
        }
      } else {
        const remote = await git(["remote", "get-url", "origin"]);
        if (remote.code !== 0 || remote.stdout.trim() !== input.url) {
          throw new ConnectionError("repository_changed", "A different repository needs a new workspace.");
        }
      }
      // Keep depth mandatory: Git rejects dumb HTTP before its object walker can follow alternate URLs.
      // Smart HTTP packfile URI downloads are separately disabled by fetch.uriprotocols.
      const fetched = await git([
        "fetch",
        "--no-tags",
        "--depth=1",
        "--no-recurse-submodules",
        "--force",
        "--",
        input.url,
        `+${ref}:${ref}`,
      ]);
      if (fetched.code !== 0) {
        throw new ConnectionError(
          "repository_fetch",
          "The repository or branch could not be fetched. Check the clone URL, branch and access token.",
        );
      }
      const verified = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
      const head = verified.stdout.trim();
      if (verified.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
        throw new ConnectionError("repository_head", "The selected branch did not resolve to a commit.");
      }
      if ((await git(["symbolic-ref", "HEAD", ref])).code !== 0) {
        throw new ConnectionError("repository_head", "The workspace branch could not be selected.");
      }
      if (!existing) await rename(path, final);
      return {
        url: input.url,
        branch: input.branch,
        head,
        verifiedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("repository_failed", "The repository connection could not be completed.");
    } finally {
      if (!existing) await rm(path, { recursive: true, force: true });
    }
  }
}
