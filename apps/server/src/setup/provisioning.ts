import { createHash } from "node:crypto";
import { Trail, type OperationLedger, type Runner, type RunnerHandle, type ServiceProfile, type SetupRun } from "@ephyra/core";
import { redact } from "@ephyra/agent";
import { profileDigest } from "@ephyra/runner";
import { canonicalJson } from "../audit.ts";

export type SetupProvisioningOptions = {
  runner: Runner; profile: ServiceProfile; ledger: OperationLedger; repoUrl: string;
  /** Authenticated owner DID and workspace, not a mutable alias. */
  scope: string;
  secrets?: string[];
  commandTimeoutMs?: number;
  installTimeoutMs?: number;
  leaseS?: number;
  maxCommands?: number;
  now?: () => Date;
};
export type SetupProvisioningResult = {
  artifacts: SetupRun["artifacts"]; verification: boolean; provisioned: boolean; detail: string;
};
export type SetupCommandReceipt = {
  index: number; phase: "identity" | "toolchain" | "install" | "verification";
  name: string; argv: string[]; startedAt: string; finishedAt: string;
  status: "passed" | "failed" | "timed_out" | "unknown" | "output_limit";
  exit: number | null; durationMs: number | null; timedOut: boolean | null;
  stdout: string; stderr: string; outputTruncated: boolean;
};
type Candidate = { name: string; command: string };
type Manager = "npm" | "pnpm" | "yarn" | "bun";
type Toolchain = { manager: Manager; version: string; lockfile: string; lockDigest: string; manifestDigest: string };
type Cleanup = { status: "not_allocated" | "destroyed" | "reconciliation_required"; at?: string };
type Status = "passed" | "failed" | "unavailable" | "reconciliation_required";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => sha(canonicalJson(value));
const MAX_DOCUMENT = 256000;
const MAX_OUTPUT = 128000;
const COMMAND_NAME = /^(test|typecheck|build|lint)(?::[a-zA-Z0-9._:-]+)?$/;
const lockfiles: Array<{ name: string; manager: Manager }> = [
  { name: "npm-shrinkwrap.json", manager: "npm" }, { name: "package-lock.json", manager: "npm" },
  { name: "pnpm-lock.yaml", manager: "pnpm" }, { name: "yarn.lock", manager: "yarn" },
  { name: "bun.lock", manager: "bun" }, { name: "bun.lockb", manager: "bun" },
];
class UnavailableSetup extends Error {}
class FailedBaseline extends Error {}

function verificationDocument(run: SetupRun, maxCommands: number): { document: Record<string, unknown>; commands: Candidate[] } {
  const files = run.artifacts.filter(a => a.path === "ephyra/verification.json");
  const file = files[0];
  if (files.length !== 1 || !file || file.content.length > MAX_DOCUMENT || sha(file.content) !== file.digest) {
    throw new UnavailableSetup("The recorded verification plan is unavailable or changed.");
  }
  let document: Record<string, unknown>;
  try { document = JSON.parse(file.content) as Record<string, unknown>; }
  catch { throw new UnavailableSetup("The recorded verification plan is invalid."); }
  if (!document || document.schema !== 1 || !Array.isArray(document.commands) || document.commands.length > maxCommands) {
    throw new UnavailableSetup("The verification command list is invalid or exceeds the setup budget.");
  }
  const commands: Candidate[] = [];
  for (const item of document.commands as Array<Partial<Candidate> | null>) {
    if (!item || typeof item.name !== "string" || !COMMAND_NAME.test(item.name) || typeof item.command !== "string" ||
        !item.command.trim() || item.command.length > 2000 || item.command.includes("\0") || commands.some(c => c.name === item.name)) {
      throw new UnavailableSetup("The verification command list contains an empty, duplicate or unsupported script.");
    }
    commands.push({ name: item.name, command: item.command });
  }
  if (!commands.some(c => /^(test|typecheck|build)(:|$)/.test(c.name))) {
    throw new UnavailableSetup("No nonempty test, typecheck or build script was discovered. This toolchain needs a verification adapter.");
  }
  return { document, commands };
}

function setupTrail(run: SetupRun, scope: string, leaseS: number): Trail {
  const bytes = sha(`${scope}:${run.id}`);
  const id = `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-5${bytes.slice(13, 16)}-a${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
  // An execution context only: no synthetic signal, model decision, proof, cost or journal event is created.
  return Trail.parse({ schema: 1, id, short: `setup-${run.id.slice(0, 8)}`, repo: run.repository.url,
    title: "Repository setup verification", rev: 1, state: "proving", signals: [], area: "setup", risk: "medium",
    route: "research_only", severity: 0, base: { ref: run.repository.branch, sha: run.repository.head }, head: run.repository.head,
    checkpoints: { spend: [] }, attempts: { proof: 0, maxProof: 1 }, mirrors: {},
    budget: { tokensUsed: 0, tokensMax: 1, wallclockMaxS: leaseS, spendMicrousdUsed: 0, spendMicrousdMax: 0 },
    createdAt: run.startedAt, updatedAt: run.updatedAt });
}

/** Real, bounded sandbox setup. This records a repository baseline, never a repaired-production claim. */
export async function provisionSetup(options: SetupProvisioningOptions, run: SetupRun): Promise<SetupProvisioningResult> {
  const { runner, profile, ledger } = options;
  const maxCommands = options.maxCommands ?? 16;
  const commandMs = Math.min(options.commandTimeoutMs ?? 120000, profile.limits.timeoutS * 1000);
  const installMs = Math.min(options.installTimeoutMs ?? 300000, profile.limits.timeoutS * 1000);
  const leaseS = options.leaseS ?? Math.ceil(Math.min(3600000, installMs + commandMs * (maxCommands + 3) + 30000) / 1000);
  if (!options.scope.trim() || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.repository.head) ||
      !Number.isInteger(maxCommands) || maxCommands < 1 || maxCommands > 32 ||
      !Number.isFinite(commandMs) || commandMs <= 0 || commandMs > 600000 ||
      !Number.isFinite(installMs) || installMs <= 0 || installMs > 900000 ||
      !Number.isInteger(leaseS) || leaseS <= 0 || leaseS > 3600) throw new TypeError("Invalid setup execution configuration.");
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const clean = (value: string, limit = MAX_OUTPUT) => redact(value, options.secrets ?? [], limit);
  const cleanJson = (value: unknown): unknown => {
    if (typeof value === "string") return clean(value, MAX_DOCUMENT);
    if (Array.isArray(value)) return value.map(cleanJson);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, cleanJson(item)]));
    return value;
  };
  const verificationText = run.artifacts.find(a => a.path === "ephyra/verification.json")?.content ?? "";
  let verificationPlan: unknown = { invalidDocumentDigest: sha(verificationText) };
  try {
    const candidate = JSON.parse(verificationText) as Record<string, unknown> | null;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      // Our recorded baseline/status/note are output, not a new command authorization.
      verificationPlan = { schema: candidate.schema ?? null, commands: candidate.commands ?? null, required: candidate.required ?? null };
    }
  } catch { /* Invalid documents get a stable unavailable receipt below. */ }
  const planDigest = digest({ scope: options.scope, setupId: run.id, head: run.repository.head, runner: runner.name,
    profile: profileDigest(profile), repoUrlDigest: sha(options.repoUrl), maxCommands, commandMs, installMs, leaseS,
    verificationPlan });
  const key = `setup:provision:${digest({ scope: options.scope, id: run.id })}`;
  const resultKey = `${key}:result`, handleKey = `${key}:handle`;
  const claim = await ledger.begin(key, planDigest);
  let handle: RunnerHandle | undefined;
  let toolchain: Toolchain | null = null;
  const receipts: SetupCommandReceipt[] = [];
  let document: Record<string, unknown> = {};
  let status: Status = "unavailable", detail = "Sandbox setup has not been verified.";
  let installed = false, verified = false;
  let cleanup: Cleanup = { status: "not_allocated" };
  const startedAt = now();
  const assemble = (): SetupProvisioningResult => {
    const provisioned = installed && cleanup.status === "destroyed";
    const verification = verified && status === "passed" && provisioned;
    const record = { schema: 1, status, verification, provisioned, head: run.repository.head, setupId: run.id,
      runner: runner.name, profileDigest: profileDigest(profile), startedAt, finishedAt: now(),
      handleId: handle?.id ?? null, toolchain, receipts, cleanup, detail };
    const updates: Record<string, string> = {
      "ephyra/provisioning.json": JSON.stringify(cleanJson(record), null, 2),
      "ephyra/verification.json": JSON.stringify(cleanJson({ ...document,
        baseline: { status, verified: verification, head: run.repository.head, receipt: "ephyra/provisioning.json" },
        note: "Baseline receipts describe setup commands. Repro, patch, regression, intent and landing evidence remain separate requirements." }), null, 2),
    };
    const artifacts = run.artifacts.filter(a => !(a.path in updates)).map(a => {
      const content = clean(a.content, MAX_DOCUMENT); return { ...a, content, digest: sha(content) };
    });
    for (const [path, content] of Object.entries(updates)) {
      // Redact values before serialization; redacting or truncating serialized JSON can break it.
      artifacts.push({ path, content, digest: sha(content) });
    }
    return { artifacts, verification, provisioned, detail };
  };
  const teardown = async () => {
    if (!handle) return;
    try {
      const receipt = await runner.destroy(handle);
      if (receipt.destroyed !== true || !Number.isFinite(Date.parse(receipt.at))) throw new Error("invalid cleanup receipt");
      cleanup = { status: "destroyed", at: receipt.at };
    } catch {
      cleanup = { status: "reconciliation_required" };
      status = "reconciliation_required"; verified = false;
      detail = "Sandbox cleanup is not confirmed. Reconcile the recorded resource before another setup attempt.";
    }
  };
  if (!claim.fresh) {
    const saved = await ledger.get(resultKey);
    if (saved?.status === "done") return saved.result as SetupProvisioningResult;
    const resource = await ledger.get(handleKey);
    if (resource?.status === "done") handle = resource.result as RunnerHandle;
    for (let index = 0; index < maxCommands + 4; index++) {
      const receipt = await ledger.get(`${key}:command:${index}:observed`);
      if (receipt?.status === "done") receipts.push(receipt.result as SetupCommandReceipt);
    }
    try { document = verificationDocument(run, maxCommands).document; } catch { /* Retain explicit unavailable state. */ }
    status = "reconciliation_required";
    detail = "A prior setup attempt has no complete receipt. It was not allocated or executed again.";
    // Do not tear down another worker's live lease. An expired known lease can still be cleaned up.
    if (handle && Date.parse(handle.leaseExpiresAt) <= Date.parse(now())) await teardown();
    return assemble();
  }
  const execute = async (phase: SetupCommandReceipt["phase"], name: string, argv: string[], timeoutMs: number): Promise<SetupCommandReceipt> => {
    if (!handle) throw new Error("setup handle unavailable");
    const index = receipts.length, commandKey = `${key}:command:${index}`;
    const commandPlan = digest({ planDigest, handle: handle.id, argv, timeoutMs });
    const commandClaim = await ledger.begin(commandKey, commandPlan);
    if (!commandClaim.fresh) throw new Error("setup command already claimed");
    const receipt: SetupCommandReceipt = { index, phase, name, argv: argv.map(a => clean(a, 2000)), startedAt: now(), finishedAt: now(),
      status: "unknown", exit: null, durationMs: null, timedOut: null, stdout: "", stderr: "", outputTruncated: false };
    let stdout = "", stderr = "", count = 0, terminal = false, invalid = false;
    try {
      for await (const output of runner.exec(handle, argv, { deadlineMs: timeoutMs,
        env: { CI: "1", GIT_TERMINAL_PROMPT: "0", NPM_CONFIG_UPDATE_NOTIFIER: "false", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } })) {
        if ("exit" in output) {
          if (terminal || !Number.isInteger(output.exit) || !Number.isFinite(output.durationMs)
              || output.durationMs < 0 || typeof output.timedOut !== "boolean") {
            invalid = true; continue;
          }
          terminal = true; receipt.exit = output.exit; receipt.durationMs = output.durationMs; receipt.timedOut = output.timedOut;
        } else {
          if (terminal || typeof output.chunk !== "string" || !["stdout", "stderr"].includes(output.stream)) { invalid = true; continue; }
          count += Buffer.byteLength(output.chunk);
          if (count > MAX_OUTPUT) receipt.outputTruncated = true;
          else if (output.stream === "stdout") stdout += output.chunk;
          else stderr += output.chunk;
        }
      }
      if (terminal && !invalid) receipt.status = receipt.timedOut ? "timed_out"
        : receipt.outputTruncated ? "output_limit" : receipt.exit === 0 ? "passed" : "failed";
    } catch { /* Unknown outcomes are recorded with no invented exit or raw provider error. */ }
    receipt.finishedAt = now();
    if (!receipt.outputTruncated) { receipt.stdout = clean(stdout); receipt.stderr = clean(stderr); }
    // On overflow omit both streams, including potentially partial secrets at the truncation boundary.
    receipts.push(receipt);
    const observedKey = `${commandKey}:observed`;
    await ledger.begin(observedKey, commandPlan); await ledger.complete(observedKey, receipt);
    if (receipt.status === "unknown") await ledger.markAmbiguous(commandKey, "Setup command outcome is unknown; no automatic retry.");
    else await ledger.complete(commandKey, receipt);
    if (receipt.status === "unknown") throw new Error("setup command needs reconciliation");
    return receipt;
  };
  const manifest = async (): Promise<{ raw: Uint8Array; value: Record<string, unknown> }> => {
    const raw = await runner.readFile(handle!, "package.json");
    if (!raw || raw.byteLength > MAX_DOCUMENT) throw new UnavailableSetup("This repository needs a supported package manifest and verification adapter.");
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(raw));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return { raw, value: value as Record<string, unknown> };
    } catch { throw new UnavailableSetup("The repository package manifest is invalid."); }
  };
  try {
    const parsed = verificationDocument(run, maxCommands); document = parsed.document;
    if (!runner.capabilities.shell) throw new UnavailableSetup("The selected runner does not support repository commands.");
    const allocation = await ledger.begin(handleKey, planDigest);
    if (!allocation.fresh) throw new Error("setup allocation already claimed");
    handle = await runner.allocate({ trail: setupTrail(run, options.scope, leaseS), attempt: 1, repoUrl: options.repoUrl,
      commit: run.repository.head, profile, leaseS, operationKey: `${key}:allocate` });
    await ledger.complete(handleKey, handle);
    cleanup = { status: "reconciliation_required" };
    const identity = await execute("identity", "checkout", ["git", "rev-parse", "HEAD"], commandMs);
    if (identity.status !== "passed" || identity.stdout.trim() !== run.repository.head) {
      throw new UnavailableSetup("The sandbox checkout does not match the recorded repository commit.");
    }
    const original = await manifest();
    const scripts = original.value.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)
        || parsed.commands.some(c => (scripts as Record<string, unknown>)[c.name] !== c.command)) {
      throw new UnavailableSetup("Verification scripts do not match the recorded repository commit.");
    }
    let declared: { manager: Manager; version: string } | null = null;
    if (original.value.packageManager !== undefined) {
      if (typeof original.value.packageManager !== "string") throw new UnavailableSetup("The declared package manager is unsupported.");
      const match = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(original.value.packageManager);
      if (!match) throw new UnavailableSetup("The declared package manager or version is unsupported.");
      declared = { manager: match[1] as Manager, version: match[2]! };
    }
    const locks = await Promise.all(lockfiles.map(async entry => ({ ...entry, bytes: await runner.readFile(handle!, entry.name) })));
    const present = locks.filter(item => item.bytes !== null);
    const managers = new Set(present.map(item => item.manager));
    if ((!declared && managers.size !== 1) || (declared && !managers.has(declared.manager))) {
      throw new UnavailableSetup("A unique package-manager lockfile is required for reproducible setup.");
    }
    const manager = declared?.manager ?? present[0]!.manager;
    const lock = present.find(item => item.manager === manager)!;
    if (lock.bytes!.byteLength > 16 * 1024 * 1024) throw new UnavailableSetup("The package lockfile exceeds the setup inspection limit.");
    const version = await execute("toolchain", manager, [manager, "--version"], commandMs);
    const versionText = version.stdout.trim();
    if (version.status !== "passed" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(versionText) || (declared && versionText !== declared.version)) {
      throw new UnavailableSetup("The required package manager version is unavailable in the selected sandbox image.");
    }
    toolchain = { manager, version: versionText, lockfile: lock.name, lockDigest: sha(lock.bytes!), manifestDigest: sha(original.raw) };
    const install = manager === "npm" ? ["npm", "ci", "--no-audit", "--no-fund"]
      : manager === "bun" ? ["bun", "install", "--frozen-lockfile"]
      : manager === "pnpm" ? ["pnpm", "install", "--frozen-lockfile"]
      : ["yarn", "install", Number(versionText.split(".")[0]) >= 2 ? "--immutable" : "--frozen-lockfile"];
    const dependency = await execute("install", "dependencies", install, installMs);
    if (dependency.status !== "passed") throw new FailedBaseline("Dependency installation did not pass. Inspect the recorded setup receipt.");
    installed = true;
    for (const command of parsed.commands) {
      const current = (await manifest()).value.scripts;
      if (!current || typeof current !== "object" || (current as Record<string, unknown>)[command.name] !== command.command) {
        throw new UnavailableSetup("A verification script changed during setup and was not executed.");
      }
      await execute("verification", command.name, [manager, "run", command.name], commandMs);
    }
    const finalHead = await execute("identity", "final_checkout", ["git", "rev-parse", "HEAD"], commandMs);
    if (finalHead.status !== "passed" || finalHead.stdout.trim() !== run.repository.head) {
      throw new UnavailableSetup("The repository commit changed during baseline verification.");
    }
    verified = receipts.filter(r => r.phase === "verification").length === parsed.commands.length &&
      receipts.filter(r => r.phase === "verification").every(r => r.status === "passed");
    status = verified ? "passed" : "failed";
    detail = verified ? "The recorded dependency install and baseline checks passed in the sandbox."
      : "Baseline checks ran and found failures. Inspect their recorded exits and output before enabling verification.";
  } catch (error) {
    if (error instanceof UnavailableSetup) { status = "unavailable"; detail = error.message; }
    else if (error instanceof FailedBaseline) { status = "failed"; detail = error.message; }
    else {
      status = "reconciliation_required";
      detail = "Setup has an incomplete or unknown operation receipt. No paid allocation or command will be repeated automatically.";
    }
  } finally { await teardown(); }
  const result = assemble();
  await ledger.begin(resultKey, planDigest); await ledger.complete(resultKey, result);
  if (status === "reconciliation_required") await ledger.markAmbiguous(key, "Setup has an unknown operation or cleanup outcome.");
  else await ledger.complete(key, result);
  return result;
}
