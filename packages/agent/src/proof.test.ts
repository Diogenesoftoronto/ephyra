import { expect, test } from "bun:test";
import fc from "fast-check";
import { Unverified, type Runner, type RunnerHandle, type Trail } from "@ephyra/core";
import { buildProof, parseTestOutput, type ProofOptions } from "./proof";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base = "a".repeat(40), head = "b".repeat(40);
const handle = { id: "fixture", workdir: "/fixture" } as RunnerHandle;
const trail = { id: "fixture", rev: 1, risk: "low" } as Trail;

// Model the runner boundary, with actual per-call observations rather than a claimed proof result.
function fixture(outcomes: [number[], number[]]) {
  const calls = [0, 0];
  let executions = 0, evaluations = 0;
  const removed: string[] = [];
  const operations: string[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const runner: Runner = {
    name: "fixture", capabilities: { checkpoint: "none", network: ["none"], shell: true, browser: false },
    allocate: unused, checkpoint: unused, restore: unused, exportArtifacts: unused, destroy: unused,
    readFile: async () => new TextEncoder().encode("fixture probe"), writeFile: async () => {},
    async *exec(_handle, cmd, opts) {
      executions++;
      operations.push(`${opts.cwd ?? "root"}:${cmd[0]}`);
      if (cmd[0] === "sh") {
        const index = opts.cwd!.endsWith("-0") ? 0 : 1;
        const run = calls[index]!++;
        const exit = outcomes[index][run];
        if (exit === undefined) throw new Error("unexpected probe run");
        yield { stream: "stdout", chunk: `attempt ${run + 1}: secret=hidden-test-value` };
        yield { exit, durationMs: 1, timedOut: false };
      } else {
        if (cmd[2] === "remove") removed.push(cmd.at(-1)!);
        yield { stream: "stdout", chunk: cmd[0] === "bun" ? "1 pass\n0 fail\n" : "" };
        yield { exit: 0, durationMs: 1, timedOut: false };
      }
    },
  };
  const build = (probeRuns?: number, extra: Partial<ProofOptions> = {}) => buildProof({ runner, handle, trail, base, head,
    probe: ".ephyra/repro/example.sh", testCommand: ["bun", "test"], probeRuns,
    evaluate: () => { evaluations++; return { passed: true, missing: [] }; },
    ...extra,
  });
  return { build, calls, removed, operations, get executions() { return executions; }, get evaluations() { return evaluations; } };
}

test("stable proofs record each of three observed runs at both revisions", async () => {
  const f = fixture([[1, 1, 1], [0, 0, 0]]);
  const result = await f.build();
  expect(f.calls).toEqual([3, 3]);
  expect(f.evaluations).toBe(1);
  expect(f.removed).toHaveLength(2);
  for (const item of result.items.filter(i => i.kind === "repro_before" || i.kind === "repro_after")) {
    for (let n = 1; n <= 3; n++) expect(item.log).toContain(`Run ${n} (exit`);
    expect(item.log).not.toContain("hidden-test-value");
  }
});

test("any unstable repeat prevents evaluation and still removes both worktrees", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10 }), fc.boolean(), fc.integer({ min: 1, max: 9 }),
    async (runs, atHead, offset) => {
      const failedRun = 1 + ((offset - 1) % (runs - 1));
      const outcomes: [number[], number[]] = [Array(runs).fill(1), Array(runs).fill(0)];
      outcomes[atHead ? 1 : 0][failedRun] = atHead ? 1 : 0;
      const f = fixture(outcomes);
      await expect(f.build(runs)).rejects.toBeInstanceOf(Unverified);
      expect(f.evaluations).toBe(0);
      expect(f.calls[atHead ? 1 : 0]).toBe(failedRun + 1);
      expect(f.removed).toHaveLength(2);
    }));
});

test("invalid repetition counts fail before any runner operation", async () => {
  for (const runs of [NaN, Infinity, -1, 0, 1, 2.5, 11]) {
    const f = fixture([[], []]);
    await expect(f.build(runs)).rejects.toThrow("probeRuns");
    expect(f.executions).toBe(0);
  }
});

test("each revision prepares dependencies before its first probe and retains preparation evidence", async () => {
  const f = fixture([[1, 1, 1], [0, 0, 0]]);
  const prepared: string[] = [];
  const result = await f.build(undefined, { prepareRevision: async revision => {
    expect(revision.remainingMs).toBeGreaterThan(0);
    expect(f.operations.some(op => op === `${revision.cwd}:sh`)).toBe(false);
    prepared.push(revision.commit);
    return { testCommand: ["bun", "test"], log: `installed at ${revision.commit}` };
  } });
  expect(prepared).toEqual([base, head]);
  const tests = result.items.find(item => item.kind === "tests");
  expect(tests?.log).toContain(`installed at ${base}`); expect(tests?.log).toContain(`installed at ${head}`);
});

test("unavailable preparation never runs probes or evaluates a proof", async () => {
  const f = fixture([[], []]);
  await expect(f.build(undefined, { prepareRevision: async () => { throw new Unverified("dependencies"); } })).rejects.toBeInstanceOf(Unverified);
  expect(f.calls).toEqual([0, 0]); expect(f.evaluations).toBe(0); expect(f.removed).toHaveLength(2);
});

test("test command identity preserves argv boundaries between revisions", async () => {
  const f = fixture([[1, 1, 1], [0, 0, 0]]);
  await expect(f.build(undefined, { prepareRevision: async revision => ({
    testCommand: revision.commit === base ? ["bun", "test --flag"] : ["bun", "test", "--flag"],
  }) })).rejects.toThrow("test command changed");
  expect(f.evaluations).toBe(0); expect(f.removed).toHaveLength(2);
});

test("parser retains Bun and Cargo counts and their actual failure identities", () => {
  expect(parseTestOutput("(fail) old bug [1.20ms]\n2 pass\n1 fail\n", 1)).toMatchObject({ passed: 2, failed: 1, failures: ["old bug"] });
  expect(parseTestOutput("test module::broken ... FAILED\ntest result: FAILED. 2 passed; 1 failed; 0 ignored;\n", 1))
    .toMatchObject({ passed: 2, failed: 1, failures: ["module::broken"] });
});

test("Jest and Vitest passing and failing reports have source-bound identities", () => {
  const jest = "FAIL src/one.test.ts (2.100 s)\n  ● suite › rejects invalid input\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 2 passed, 3 total\n";
  expect(parseTestOutput(jest, 1)).toMatchObject({ passed: 2, failed: 1, failures: ["src/one.test.ts > suite › rejects invalid input"] });
  const vitest = " FAIL  src/one.test.ts > suite > rejects invalid input\n Test Files 1 failed (1)\n      Tests 1 failed | 2 passed (3)\n";
  expect(parseTestOutput(vitest, 1)).toMatchObject({ passed: 2, failed: 1, failures: ["src/one.test.ts > suite > rejects invalid input"] });
  expect(parseTestOutput("Tests: 2 passed, 2 total\n", 0)).toMatchObject({ passed: 2, failed: 0 });
  expect(parseTestOutput("Tests 2 passed (2)\n", 0)).toMatchObject({ passed: 2, failed: 0 });
});

test("real node:test TAP output parses nested failures without counting suite wrappers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-tap-"));
  try {
    const file = join(directory, "fixture.mjs");
    await writeFile(file, "import { test, describe, it } from 'node:test'; import assert from 'node:assert/strict';\n"
      + "test('passes', () => assert.equal(1,1)); describe('group', () => { it('fails', () => assert.equal(1,2)); });\n");
    const node = Bun.which("node");
    if (!node) throw new Error("node:test fixture requires a local Node installation");
    const process = Bun.spawn([node, "--test", "--test-reporter=tap", file], {
      stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", CI: "1" },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit).toBe(1);
    expect(parseTestOutput(stdout + stderr, exit)).toMatchObject({ passed: 1, failed: 1, failures: ["group > fails"] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("empty, interrupted, mixed, inconsistent or identity-free summaries remain unverified", () => {
  for (const [output, exit] of [
    ["Tests: 0 total\n", 0], ["Tests 2 skipped (2)\n", 0],
    ["Tests: 1 failed, 1 total\n", 1], ["Tests 3 passed (2)\n", 0],
    ["TAP version 13\n# pass 2\n# fail 0\n", 0],
    ["TAP version 13\n# tests 2\n# pass 1\n# fail 0\n# cancelled 1\n", 1],
    ["1 pass\n0 fail\nTests: 1 passed, 1 total\n", 0],
    ["Tests: 1 passed, 1 total\n", -1],
  ] as const) expect(() => parseTestOutput(output, exit)).toThrow(Unverified);
});

test("reported failed tests can never be turned into a passing process receipt", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 20 }), (failed, passed) => {
    const names = Array.from({ length: failed }, (_, n) => `case-${n}`);
    const report = `FAIL file.test.ts\n${names.map(name => `  ● ${name}\n`).join("")}`
      + `Tests: ${failed} failed, ${passed} passed, ${failed + passed} total\n`;
    expect(parseTestOutput(report, 1)).toMatchObject({ passed, failed, failures: names.map(name => `file.test.ts > ${name}`) });
    expect(() => parseTestOutput(report, 0)).toThrow(Unverified);
  }));
});
