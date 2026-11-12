// Radicle patches from the deployment's own identity. The owner's key never reaches the server: Ephyra opens a patch as
// itself, and the owner merges it like any contributor's. Only `refs/patches` pushes and patch reads are allowed; the
// default branch can never be moved from here.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Unverified } from "@ephyra/core";
import type { CommandRunner } from "@ephyra/forge";

/** A command runner that can add environment variables (the identity's RAD_HOME and passphrase) to one call. */
export type EnvRunner = (argv: string[], cwd: string, env?: Record<string, string>) => Promise<{ stdout: string; stderr: string; code: number }>;

/** The real runner: a child process with the server's PATH plus the given variables, 60 s deadline. */
export const spawnRunner: EnvRunner = async (argv, cwd, env = {}) => {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", TERM: "dumb", ...env },
    timeout: 60_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

export type RadicleWriterConfig = {
  /** RAD_HOME of the deployment identity (keys, storage, node socket). */
  home: string;
  /** Read once at start-up from the environment; never logged or written to disk by Ephyra. */
  passphrase?: string;
};

const RID = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;
const OID = /^[a-f0-9]{40}$/;

/** True when a git argv is a patch push and nothing else: `git push <remote> <oid>:refs/patches [-o patch.*=…]`. */
export function isPatchPush(argv: readonly string[]): boolean {
  if (argv[0] !== "git" || argv[1] !== "push" || argv.length < 4) return false;
  const refspec = argv[3]!;
  const [src, dst] = refspec.split(":");
  if (!src || !OID.test(src) || !(dst === "refs/patches" || /^refs\/heads\/patches\/[a-f0-9]{40}$/.test(dst ?? ""))) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(argv[2]!)) return false;
  const rest = argv.slice(4);
  if (rest.length % 2) return false;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "-o" || !/^patch\.(message|base)=/.test(rest[i + 1]!)) return false;
    if (/[\0\r]/.test(rest[i + 1]!)) return false;
  }
  return true;
}

/** True for the read-only `rad` calls the adapter makes to verify and withdraw its own patches. */
export function isPatchRead(argv: readonly string[], repository: string): boolean {
  if (argv[0] !== "rad") return false;
  const cob = argv[1] === "cob" && ["list", "show"].includes(argv[2] ?? "") && argv.includes("xyz.radicle.patch");
  const archive = argv[1] === "patch" && argv[2] === "archive" && OID.test(argv[3] ?? "");
  const repoIndex = argv.indexOf("--repo");
  return (cob || archive) && repoIndex > 0 && argv[repoIndex + 1] === repository;
}

/**
 * A command runner for one Radicle workspace: it checks out the repository into the deployment identity's storage once,
 * then allows only patch pushes and patch reads, each with the identity's environment. Anything else is refused.
 */
export function radicleWriter(config: RadicleWriterConfig, repository: string, base: EnvRunner = spawnRunner): CommandRunner {
  if (!RID.test(repository)) throw new Error("invalid Radicle repository id");
  const env = { RAD_HOME: config.home, ...(config.passphrase ? { RAD_PASSPHRASE: config.passphrase } : {}) };
  let ready: Promise<void> | null = null;
  const prepare = (cwd: string) => ready ??= (async () => {
    await mkdir(config.home, { recursive: true, mode: 0o700 });
    const seeded = await base(["rad", "seed", repository, "--scope", "followed"], cwd, env);
    if (seeded.code) throw new Unverified("Radicle identity could not seed the repository");
    const remote = await base(["git", "remote", "get-url", "rad"], cwd, env);
    if (remote.code) {
      const nid = (await base(["rad", "node", "status", "--only", "nid"], cwd, env)).stdout.trim();
      if (!/^z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(nid)) throw new Unverified("Radicle node identity");
      const added = await base(["git", "remote", "add", "rad", `rad://${repository.slice(4)}/${nid}`], cwd, env);
      if (added.code) throw new Unverified("Radicle remote");
    }
  })().catch((error) => { ready = null; throw error; });
  return async (argv, cwd) => {
    if (isPatchPush(argv)) {
      await prepare(cwd);
      return base([...argv.slice(0, 2), "rad", ...argv.slice(3)], cwd, env);
    }
    if (isPatchRead(argv, repository)) return base(argv, cwd, env);
    if (argv[0] === "git" && ["show", "rev-parse", "cat-file", "merge-base"].includes(argv[1] ?? "")) return base(argv, cwd);
    throw new Unverified("Radicle workspaces only open patches; this command is not allowed");
  };
}

/** The deployment's Radicle writer config, or null with the reason Radicle workspaces stay read-only. */
export function radicleWriterConfig(env: { EPHYRA_RADICLE_HOME?: string; EPHYRA_RADICLE_PASSPHRASE?: string; EPHYRA_DATA_DIR: string }):
  { config: RadicleWriterConfig; reason: null } | { config: null; reason: string } {
  if (!env.EPHYRA_RADICLE_HOME)
    return { config: null, reason: "This server has no Radicle identity (EPHYRA_RADICLE_HOME), so Radicle workspaces are read-only." };
  return { config: { home: env.EPHYRA_RADICLE_HOME.startsWith("/") ? env.EPHYRA_RADICLE_HOME : join(env.EPHYRA_DATA_DIR, env.EPHYRA_RADICLE_HOME),
    ...(env.EPHYRA_RADICLE_PASSPHRASE ? { passphrase: env.EPHYRA_RADICLE_PASSPHRASE } : {}) }, reason: null };
}
