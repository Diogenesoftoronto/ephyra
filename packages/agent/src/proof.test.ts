import { expect, test } from "bun:test";
import fc from "fast-check";
import { Unverified, type Runner, type RunnerHandle, type Trail } from "@ephyra/core";
import { buildProof } from "./proof";

const base = "a".repeat(40), head = "b".repeat(40);
const handle = { id: "fixture", workdir: "/fixture" } as RunnerHandle;
const trail = { id: "fixture", rev: 1, risk: "low" } as Trail;

// Model the runner boundary, with actual per-call observations rather than a claimed proof result.
function fixture(outcomes: [number[], number[]]) {
  const calls = [0, 0];
  let executions = 0, evaluations = 0;
  const removed: string[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const runner: Runner = {
    name: "fixture", capabilities: { checkpoint: "none", network: ["none"], shell: true, browser: false },
    allocate: unused, checkpoint: unused, restore: unused, exportArtifacts: unused, destroy: unused,
    readFile: async () => new TextEncoder().encode("fixture probe"), writeFile: async () => {},
    async *exec(_handle, cmd, opts) {
      executions++;
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
  const build = (probeRuns?: number) => buildProof({ runner, handle, trail, base, head,
    probe: ".ephyra/repro/example.sh", testCommand: ["bun", "test"], probeRuns,
    evaluate: () => { evaluations++; return { passed: true, missing: [] }; },
  });
  return { build, calls, removed, get executions() { return executions; }, get evaluations() { return evaluations; } };
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
