import { Unverified, type ProofBundle, type ProofItem, type Runner, type RunnerHandle, type Trail } from "@ephyra/core";
import { execute } from "./execute";
import { redact } from "./redact";

export type ParsedTestResult = { passed: number; failed: number; failures: string[]; log: string };
export type PreparedProofRevision = { testCommand?: string[]; log?: string };
type UiRun = { command: string[]; parse: (output: string) => ProofItem[] };
export type ProofOptions = {
  runner: Runner; handle: RunnerHandle; trail: Trail; base: string; head: string; probe: string;
  testCommand?: string[]; ui?: UiRun[]; secrets?: string[]; deadlineMs?: number;
  /** How many times the probe runs at each revision (default 3, integer 2..10). Every run must fail at base and pass at head; any
   * disagreement means the probe is flaky and the proof is Unverified, never passed. */
  probeRuns?: number;
  /** Runs in each isolated worktree before its probes/tests; no dependencies are inherited from setup. */
  prepareRevision?: (revision: { cwd: string; commit: string; remainingMs: number }) => Promise<PreparedProofRevision>;
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

/** Counts come from a complete reporter summary; failed tests also need distinct observed identities. */
export function parseTestOutput(output: string, exit: number, secrets: string[] = []): ParsedTestResult {
  if (!Number.isInteger(exit) || exit < 0) throw new Unverified("test process did not report a normal exit");
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const bunPass = [...clean.matchAll(/^\s*(\d+) pass\s*$/gm)];
  const bunFail = [...clean.matchAll(/^\s*(\d+) fail\s*$/gm)];
  const cargo = [...clean.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  const js = [...clean.matchAll(/^\s*Tests(:|\s)\s*(.+)$/gm)];
  const tap = /^TAP version 13\s*$/m.test(clean);
  if ([Boolean(bunPass.length || bunFail.length), Boolean(cargo.length), Boolean(js.length), tap].filter(Boolean).length > 1) {
    throw new Unverified("mixed test reporter summaries");
  }
  let passed: number;
  let failed: number;
  let failures: string[] = [];
  if (bunPass.length || bunFail.length) {
    if (bunPass.length > 1 || bunFail.length > 1 || cargo.length || js.length) throw new Unverified("multiple test summaries");
    passed = Number(bunPass[0]?.[1] ?? 0);
    failed = Number(bunFail[0]?.[1] ?? 0);
    failures = [...clean.matchAll(/^\(fail\) (.+)$/gm)].map(m => m[1]!.replace(/\s+\[[\d.]+m?s\]$/, "").trim());
  } else if (cargo.length) {
    passed = cargo.reduce((n, m) => n + Number(m[1]), 0);
    failed = cargo.reduce((n, m) => n + Number(m[2]), 0);
    failures = [...clean.matchAll(/^\s*test (.+?) \.\.\. FAILED$/gm)].map(m => m[1]!);
  } else if (tap) {
    const counts = (name: string) => [...clean.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm"))];
    const pass = counts("pass"), fail = counts("fail"), total = counts("tests"), cancelled = counts("cancelled");
    if (pass.length !== 1 || fail.length !== 1 || total.length !== 1 || cancelled.some(m => Number(m[1]) !== 0)
        || /^Bail out!/m.test(clean) || /^# Interrupted while running:/m.test(clean)) throw new Unverified("incomplete TAP test summary");
    passed = Number(pass[0]![1]); failed = Number(fail[0]![1]);
    const skipped = counts("skipped"), todo = counts("todo");
    if (skipped.length > 1 || todo.length > 1 || Number(total[0]![1]) !== passed + failed
        + Number(skipped[0]?.[1] ?? 0) + Number(todo[0]?.[1] ?? 0)) throw new Unverified("TAP test count mismatch");
    const lines = clean.split("\n"), ancestors = new Map<number, string>();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const subtest = /^( *)# Subtest: (.+)$/.exec(line);
      if (subtest) {
        const level = subtest[1]!.length;
        for (const depth of ancestors.keys()) if (depth >= level) ancestors.delete(depth);
        ancestors.set(level, subtest[2]!);
      }
      const result = /^( *)not ok \d+ - (.+)$/.exec(line);
      if (!result || / # (?:SKIP|TODO|EXPECTED FAILURE)(?:\s|$)/.test(result[2]!)) continue;
      const level = result[1]!.length;
      let details = "";
      for (let next = index + 1; next < lines.length && /^ +/.test(lines[next]!)
          && lines[next]!.match(/^ */)![0].length > level; next++) details += `${lines[next]}\n`;
      if (/^\s*type: ['"]?suite['"]?\s*$/m.test(details)) continue;
      const parents = [...ancestors].filter(([depth]) => depth < level).sort(([a], [b]) => a - b).map(([, name]) => name);
      failures.push([...parents, result[2]!.trim()].join(" > "));
    }
  } else if (js.length === 1) {
    const summary = js[0]![2]!;
    const entries = [...summary.matchAll(/(\d+)\s+(passed|failed|skipped|todo)\b/g)];
    const counts = new Map(entries.map(m => [m[2]!, Number(m[1])]));
    if (counts.size !== entries.length) throw new Unverified("ambiguous JavaScript test summary");
    passed = counts.get("passed") ?? 0; failed = counts.get("failed") ?? 0;
    const total = js[0]![1] === ":" ? /\b(\d+) total\s*$/.exec(summary) : /\((\d+)\)\s*$/.exec(summary);
    if (!total || Number(total[1]) !== [...counts.values()].reduce((n, value) => n + value, 0)) {
      throw new Unverified("JavaScript test count mismatch");
    }
    if (js[0]![1] === ":") {
      let file: string | null = null;
      for (const line of clean.split("\n")) {
        const suite = /^\s*(FAIL|PASS)\s+(.+?)(?: \([\d.]+ s\))?\s*$/.exec(line);
        if (suite) { file = suite[1] === "FAIL" ? suite[2]! : null; continue; }
        const failure = /^\s*● (.+)$/.exec(line);
        if (file && failure && failure[1] !== "Console") failures.push(`${file} > ${failure[1]!.trim()}`);
      }
    } else {
      failures = [...clean.matchAll(/^\s*FAIL\s+(.+?\s+>\s+.+)\s*$/gm)].map(m => m[1]!.trim());
    }
  } else throw new Unverified("test result format");
  if (![passed, failed].every(n => Number.isSafeInteger(n) && n >= 0) || passed + failed === 0) {
    throw new Unverified("no observed executable tests");
  }
  if ((exit === 0) !== (failed === 0)) throw new Unverified("test result exit mismatch");
  const distinct = [...new Set(failures)];
  if (distinct.length !== failed) throw new Unverified("test failure identities");
  const safeFailures = distinct.map(name => redact(name, secrets));
  if (new Set(safeFailures).size !== failed) throw new Unverified("ambiguous redacted test failure identities");
  return { passed, failed, failures: safeFailures, log: redact(clean, secrets) };
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
    const tests: ParsedTestResult[] = [];
    let suite = "";
    let suiteArgv = "";
    for (let i = 0; i < 2; i++) {
      const prepared = await options.prepareRevision?.({ cwd: paths[i]!, commit: [base, head][i]!, remainingMs: remaining() });
      if (prepared?.testCommand && (!prepared.testCommand.length || prepared.testCommand.length > 100
          || prepared.testCommand.some(arg => typeof arg !== "string" || arg.includes("\0")))) {
        throw new Unverified("prepared test command");
      }
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
      const command = prepared?.testCommand ?? options.testCommand ?? await detectTest(runner, handle, paths[i]!, remaining());
      const encodedCommand = JSON.stringify(command);
      if (suiteArgv && suiteArgv !== encodedCommand) throw new Unverified("test command changed between proof revisions");
      suiteArgv = encodedCommand;
      suite = command.join(" ");
      const test = await execute(runner, handle, command, remaining(), paths[i]);
      const parsed = parseTestOutput(test.stdout + test.stderr, test.exit, options.secrets ?? []);
      if (prepared?.log) parsed.log = `Environment preparation:\n${redact(prepared.log, options.secrets)}\nTests:\n${parsed.log}`;
      tests.push(parsed);
    }
    const [before, after] = tests as [ParsedTestResult, ParsedTestResult];
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
