import { createHash } from "node:crypto";
import { ReconciliationRequired, Unverified, type OperationLedger, type Runner, type RunnerHandle, type SetupRun } from "@ephyra/core";
import { redact, type PreparedProofRevision, type ProofOptions } from "@ephyra/agent";
import { canonicalJson } from "../audit.ts";

type Manager = "npm" | "pnpm" | "yarn" | "bun";
type CommandReceipt = { argv: string[]; exit: number | null; durationMs: number | null; timedOut: boolean | null;
  stdout: string; stderr: string; complete: boolean };
type PreparationReceipt = { schema: 1; ok: boolean; setupId: string; base: string; head: string; commit: string; cwd: string;
  manager: Manager; version: string; lockDigest: string; testCommand: string[]; commands: CommandReceipt[] };
export type ProofToolchainOptions = {
  runner: Runner; handle: RunnerHandle; setup: SetupRun; base: string; head: string; ledger: OperationLedger;
  secrets?: string[];
  installTimeoutMs?: number;
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => sha(canonicalJson(value));
const managers: Manager[] = ["npm", "pnpm", "yarn", "bun"];
const locks: Record<Manager, string[]> = { npm: ["npm-shrinkwrap.json", "package-lock.json"], pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"], bun: ["bun.lock", "bun.lockb"] };
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

function artifact(setup: SetupRun, path: string): Record<string, unknown> {
  const entries = setup.artifacts.filter(a => a.path === path), entry = entries[0];
  if (entries.length !== 1 || !entry || entry.content.length > 4 * 1024 * 1024 || sha(entry.content) !== entry.digest) {
    throw new Unverified("pinned setup baseline artifact");
  }
  try {
    const value: unknown = JSON.parse(entry.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Unverified("pinned setup baseline format"); }
}

/** Each revision installs from its own lockfile; a passing setup VM is never treated as a warmed proof VM. */
export function proofToolchain(options: ProofToolchainOptions): NonNullable<ProofOptions["prepareRevision"]> {
  const { setup, runner, handle, ledger, base, head } = options;
  if (![base, head].every(value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))) throw new Unverified("exact proof revisions");
  const baseline = artifact(setup, "ephyra/provisioning.json");
  const verification = artifact(setup, "ephyra/verification.json");
  const toolchain = baseline.toolchain as Record<string, unknown> | undefined;
  if (setup.repository.head !== base || baseline.schema !== 1 || baseline.status !== "passed" || baseline.verification !== true
      || baseline.provisioned !== true || baseline.head !== base || !toolchain || !managers.includes(toolchain.manager as Manager)
      || typeof toolchain.version !== "string" || !versionPattern.test(toolchain.version)
      || typeof toolchain.lockfile !== "string" || !locks[toolchain.manager as Manager].includes(toolchain.lockfile)
      || typeof toolchain.lockDigest !== "string" || !/^[a-f0-9]{64}$/.test(toolchain.lockDigest)
      || typeof toolchain.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(toolchain.manifestDigest)) {
    throw new Unverified("a matching successful setup baseline and pinned package manager are required for proof");
  }
  if (verification.schema !== 1 || !Array.isArray(verification.commands)) throw new Unverified("recorded proof test command");
  const candidates = verification.commands.filter((c): c is { name: string; command: string } => Boolean(c)
    && typeof c === "object" && typeof c.name === "string" && /^test(?::[a-zA-Z0-9._:-]+)?$/.test(c.name)
    && typeof c.command === "string" && c.command.trim().length > 0 && c.command.length <= 2000);
  const primary = candidates.filter(c => c.name === "test");
  const selected = primary.length === 1 ? primary[0]! : primary.length === 0 && candidates.length === 1 ? candidates[0]! : null;
  if (!selected || !Array.isArray(baseline.receipts) || !baseline.receipts.some(receipt => receipt && typeof receipt === "object"
      && receipt.phase === "verification" && receipt.name === selected.name && receipt.status === "passed" && receipt.exit === 0
      && receipt.timedOut === false && receipt.outputTruncated === false)) throw new Unverified("one baselined test script must be selected for proof");
  const manager = toolchain.manager as Manager, version = toolchain.version, lockfile = toolchain.lockfile;
  const testCommand = [manager, "run", selected.name];
  const install = manager === "npm" ? ["npm", "ci", "--no-audit", "--no-fund"]
    : manager === "yarn" ? ["yarn", "install", Number(version.split(".")[0]) >= 2 ? "--immutable" : "--frozen-lockfile"]
    : [manager, "install", "--frozen-lockfile"];
  const baselineDigest = hash({ baseline, verification });
  return async ({ cwd, commit, remainingMs }) => {
    if (!/^\.ephyra-proof-[a-f0-9-]+-[01]$/.test(cwd) || ![base, head].includes(commit)
        || !Number.isFinite(remainingMs) || remainingMs <= 0) throw new Unverified("proof worktree binding");
    const deadline = Date.now() + remainingMs;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Unverified("proof preparation deadline");
      return ms;
    };
    const manifestBytes = await runner.readFile(handle, `${cwd}/package.json`);
    const lockBytes = await runner.readFile(handle, `${cwd}/${lockfile}`);
    if (!manifestBytes || manifestBytes.length > 256000 || !lockBytes || lockBytes.length > 16 * 1024 * 1024) {
      throw new Unverified("proof manifest or pinned lockfile unavailable");
    }
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>; }
    catch { throw new Unverified("proof package manifest"); }
    const manifestDigest = sha(manifestBytes), lockDigest = sha(lockBytes);
    if (commit === base && (manifestDigest !== toolchain.manifestDigest || lockDigest !== toolchain.lockDigest)) {
      throw new Unverified("proof base toolchain differs from its verified setup baseline");
    }
    // A patch may legitimately update dependencies and the lockfile. Changing manager/version or the test script needs a new baseline.
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !manifest.scripts || typeof manifest.scripts !== "object"
        || (manifest.scripts as Record<string, unknown>)[selected.name] !== selected.command) throw new Unverified("proof test script changed");
    if (manifest.packageManager !== undefined && (typeof manifest.packageManager !== "string"
        || manifest.packageManager.replace(/\+sha(?:224|256|384|512)\.[a-f0-9]+$/, "") !== `${manager}@${version}`)) {
      throw new Unverified("proof package manager changed");
    }
    const key = `proof:prepare:${hash({ handle: handle.id, cwd, commit })}`;
    const plan = hash({ handle: handle.id, cwd, commit, base, head, baselineDigest, manifestDigest, lockDigest, testCommand, install });
    const claim = await ledger.begin(key, plan);
    if (!claim.fresh) {
      if (claim.record.status !== "done") throw new ReconciliationRequired(key, "Proof installation outcome needs reconciliation.");
      const previous = claim.record.result as PreparationReceipt;
      if (!previous.ok) throw new Unverified("the recorded proof environment preparation failed");
      return { testCommand: previous.testCommand, log: JSON.stringify(previous) } satisfies PreparedProofRevision;
    }
    const receipt: PreparationReceipt = { schema: 1, ok: false, setupId: setup.id, base, head, commit, cwd,
      manager, version, lockDigest, testCommand, commands: [] };
    const execute = async (argv: string[], timeoutMs: number) => {
      const observed: CommandReceipt = { argv, exit: null, durationMs: null, timedOut: null, stdout: "", stderr: "", complete: false };
      receipt.commands.push(observed);
      let stdout = "", stderr = "", length = 0, terminal = false, invalid = false;
      try {
        for await (const item of runner.exec(handle, argv, { cwd, deadlineMs: Math.min(remaining(), timeoutMs),
          env: { CI: "1", GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_UPDATE_NOTIFIER: "false", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } })) {
          if ("exit" in item) {
            if (terminal || !Number.isInteger(item.exit) || !Number.isFinite(item.durationMs)
                || item.durationMs < 0 || typeof item.timedOut !== "boolean") { invalid = true; continue; }
            terminal = true; observed.exit = item.exit; observed.durationMs = item.durationMs; observed.timedOut = item.timedOut;
          } else {
            if (terminal) invalid = true;
            length += Buffer.byteLength(item.chunk);
            if (length <= 128000) {
              if (item.stream === "stdout") stdout += item.chunk;
              else stderr += item.chunk;
            }
          }
        }
        observed.complete = terminal && !invalid && length <= 128000;
      } finally {
        if (length <= 128000) {
          observed.stdout = redact(stdout, options.secrets ?? [], 128000);
          observed.stderr = redact(stderr, options.secrets ?? [], 128000);
        }
      }
      if (!observed.complete) throw new ReconciliationRequired(key, "Proof preparation has no complete command receipt.");
      return observed;
    };
    try {
      const identity = await execute(["git", "rev-parse", "HEAD"], 15000);
      if (identity.exit !== 0 || identity.timedOut || identity.stdout.trim() !== commit) throw new Unverified("proof worktree commit");
      const actualVersion = await execute([manager, "--version"], 15000);
      if (actualVersion.exit !== 0 || actualVersion.timedOut || actualVersion.stdout.trim() !== version) {
        throw new Unverified("baselined package manager version unavailable in proof sandbox");
      }
      const installed = await execute(install, options.installTimeoutMs ?? 120000);
      if (installed.exit !== 0 || installed.timedOut) throw new Unverified("locked dependency installation failed in proof worktree");
      const after = await runner.readFile(handle, `${cwd}/package.json`);
      const afterLock = await runner.readFile(handle, `${cwd}/${lockfile}`);
      if (!after || !afterLock || sha(after) !== manifestDigest || sha(afterLock) !== lockDigest) {
        throw new Unverified("proof installation changed the pinned manifest or lockfile");
      }
      receipt.ok = true;
      await ledger.complete(key, receipt);
      return { testCommand, log: JSON.stringify(receipt) };
    } catch (error) {
      const observedKey = `${key}:observed`;
      await ledger.begin(observedKey, plan); await ledger.complete(observedKey, receipt);
      if (error instanceof Unverified) { await ledger.complete(key, receipt); throw error; }
      await ledger.markAmbiguous(key, "Proof environment preparation has an unknown outcome; do not repeat installation.");
      throw new ReconciliationRequired(key, "Proof environment preparation needs reconciliation.");
    }
  };
}
