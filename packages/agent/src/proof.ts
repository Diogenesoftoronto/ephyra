import { Unverified, type ProofBundle, type ProofItem, type Runner, type RunnerHandle, type Trail } from "@ephyra/core";
import { execute } from "./execute";
import { redact } from "./redact";

type TestResult = { passed: number; failed: number; failures: string[]; log: string };
type UiRun = { command: string[]; parse: (output: string) => ProofItem[] };
export type ProofOptions = {
  runner: Runner; handle: RunnerHandle; trail: Trail; base: string; head: string; probe: string;
  testCommand?: string[]; ui?: UiRun[]; secrets?: string[]; deadlineMs?: number;
  /** How many times the probe runs at each revision (default 3, integer 2..10). Every run must fail at base and pass at head; any
   * disagreement means the probe is flaky and the proof is Unverified, never passed. */
  probeRuns?: number;
  evaluate: (items: ProofItem[], trail: Trail) => { passed: boolean; missing: string[] } | Promise<{ passed: boolean; missing: string[] }>;
};

async function checked(runner: Runner, handle: RunnerHandle, command: string[], ms: number, cwd?: string) {
  const result = await execute(runner, handle, command, ms, cwd);
  if (result.exit !== 0) throw new Unverified(`proof command failed: ${command[0]}`);
  return result.stdout;
}

async function detectTest(runner: Runner, handle: RunnerHandle, cwd: string, ms: number): Promise<string[]> {
  const config = await execute(runner, handle, ["sh", "-c", "cat .ephyra/config.json 2>/dev/null"], ms, cwd);
  if (config.exit === 0) {
    try {
      const value = JSON.parse(config.stdout).testCommand;
      if (Array.isArray(value) && value.length && value.every((s: unknown) => typeof s === "string")) return value;
      throw new Error("invalid testCommand");
    } catch { throw new Unverified("invalid test configuration"); }
  }
  const pkg = await execute(runner, handle, ["sh", "-c", "cat package.json 2>/dev/null"], ms, cwd);
  if (pkg.exit === 0) {
    try { if (JSON.parse(pkg.stdout).scripts?.test) return ["bun", "run", "test"]; }
    catch { throw new Unverified("invalid package.json"); }
    return ["bun", "test"];
  }
  const cargo = await execute(runner, handle, ["test", "-f", "Cargo.toml"], ms, cwd);
  if (cargo.exit === 0) return ["cargo", "test"];
  const devenv = await execute(runner, handle, ["test", "-f", "devenv.nix"], ms, cwd);
  if (devenv.exit === 0) return ["devenv", "test"];
  throw new Unverified("test command detection");
}

function parseTests(output: string, exit: number, secrets: string[]): TestResult {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const bunPass = clean.match(/(\d+) pass\b/);
  const bunFail = clean.match(/(\d+) fail\b/);
  const cargo = [...clean.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  let passed: number;
  let failed: number;
  if (bunPass || bunFail) {
    passed = Number(bunPass?.[1] ?? 0);
    failed = Number(bunFail?.[1] ?? 0);
  } else if (cargo.length) {
    passed = cargo.reduce((n, m) => n + Number(m[1]), 0);
    failed = cargo.reduce((n, m) => n + Number(m[2]), 0);
  } else throw new Unverified("test result format");
  if ((exit === 0) !== (failed === 0)) throw new Unverified("test result exit mismatch");
  const failures = [...clean.matchAll(/^\(fail\) (.+)$/gm)].map(m => m[1]!.replace(/\s+\[[\d.]+m?s\]$/, "").trim());
  failures.push(...[...clean.matchAll(/^\s*test (.+?) \.\.\. FAILED$/gm)].map(m => m[1]!));
  if (failed && new Set(failures).size !== failed) throw new Unverified("test failure identities");
  return { passed, failed, failures, log: redact(clean, secrets) };
}

export async function buildProof(options: ProofOptions): Promise<ProofBundle> {
  const { runner, handle, trail, base, head, probe } = options;
  if (![base, head].every(sha => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha))) throw new Error("invalid commit id");
  if (!/^\.ephyra\/repro\/[\w.-]+\.sh$/.test(probe)) throw new Error("invalid probe path");
  const runs = options.probeRuns ?? 3;
  if (!Number.isInteger(runs) || runs < 2 || runs > 10) throw new Error("probeRuns must be an integer from 2 to 10");
  const end = Date.now() + (options.deadlineMs ?? 300_000);
  const remaining = () => {
    const ms = end - Date.now();
    if (ms <= 0) throw new Unverified("proof deadline exceeded");
    return ms;
  };
  const suffix = crypto.randomUUID();
  // Relative to the sandbox workdir: runners confine every cwd to the workdir and reject absolute paths.
  const paths = [base, head].map((_, i) => `.ephyra-proof-${suffix}-${i}`);
  const made: string[] = [];
  const items: ProofItem[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      await checked(runner, handle, ["git", "worktree", "add", "--detach", paths[i]!, [base, head][i]!], remaining());
      made.push(paths[i]!);
    }
    const probeData = await runner.readFile(handle, probe);
    if (!probeData) throw new Unverified("probe file unavailable");
    // The same probe is used for both revisions, including when it was introduced by the patch.
    await runner.writeFile(handle, `.ephyra-proof-${suffix}-0/.ephyra-probe.sh`, probeData);
    await runner.writeFile(handle, `.ephyra-proof-${suffix}-1/.ephyra-probe.sh`, probeData);
    const tests: TestResult[] = [];
    let suite = "";
    for (let i = 0; i < 2; i++) {
      const logs: string[] = [];
      for (let n = 0; n < runs; n++) {
        const result = await execute(runner, handle, ["sh", ".ephyra-probe.sh"], remaining(), paths[i]);
        if ((i === 0 && result.exit === 0) || (i === 1 && result.exit !== 0)) {
          if (n === 0) throw new Unverified("probe outcome");
          throw new Unverified(`flaky probe: run ${n + 1} of ${runs} at ${i === 0 ? "base" : "head"} disagreed with run 1`);
        }
        logs.push(`Run ${n + 1} (exit ${result.exit}):\n${redact(result.stdout + result.stderr, options.secrets)}`);
      }
      const log = `${runs} of ${runs} runs ${i === 0 ? "failed" : "passed"}.\n` + logs.join("\n");
      items.push(i === 0 ? { kind: "repro_before", probe, result: "fail", log } : { kind: "repro_after", probe, result: "pass", log });
      const command = options.testCommand ?? await detectTest(runner, handle, paths[i]!, remaining());
      suite = command.join(" ");
      const test = await execute(runner, handle, command, remaining(), paths[i]);
      tests.push(parseTests(test.stdout + test.stderr, test.exit, options.secrets ?? []));
    }
    const [before, after] = tests as [TestResult, TestResult];
    const prior = new Set(before.failures);
    items.push({ kind: "tests", suite, passed: after.passed, failed: after.failed,
      newFailures: after.failures.filter(failure => !prior.has(failure)).length,
      log: `Base:\n${before.log}\nHead:\n${after.log}` });
    const stats = await checked(runner, handle, ["git", "diff", "--numstat", base, head], remaining());
    const entries = stats.trim().split("\n").filter(Boolean).map(line => line.split("\t"));
    if (entries.some(entry => entry.length !== 3 || entry[0] === "-" || entry[1] === "-")) {
      throw new Unverified("binary or ambiguous diff scope");
    }
    const diff = await checked(runner, handle, ["git", "diff", "--no-ext-diff", "--unified=0", base, head], remaining());
    items.push({ kind: "diff_scope", files: entries.length, lines: entries.reduce((n, e) => n + Number(e[0]) + Number(e[1]), 0),
      paths: entries.map(e => e[2]!), exportedTypesChanged: /^[+-](?![+-]).*\b(?:export|pub)\b/m.test(diff) });
    for (const ui of options.ui ?? []) {
      const run = await execute(runner, handle, ui.command, remaining(), paths[1]);
      if (run.exit !== 0) throw new Unverified("UI proof command failed");
      for (const item of ui.parse(run.stdout + run.stderr)) {
        if (!["story_render", "story_interaction", "story_visual_diff"].includes(item.kind)) {
          throw new Unverified("invalid UI proof item");
        }
        items.push(item.kind === "story_interaction" ? { ...item, log: redact(item.log, options.secrets) } : item);
      }
    }
    const evaluation = await options.evaluate(items, trail);
    return { schema: 1, trail: trail.id, rev: trail.rev, risk: trail.risk, base, head, items,
      ...evaluation, env: { runner: runner.name }, computedAt: new Date().toISOString() };
  } finally {
    for (const path of made.reverse()) {
      await checked(runner, handle, ["git", "worktree", "remove", "--force", path], Math.max(1000, end - Date.now()));
    }
  }
}

export class ProofBuilder {
  buildProof(options: ProofOptions) { return buildProof(options); }
}
