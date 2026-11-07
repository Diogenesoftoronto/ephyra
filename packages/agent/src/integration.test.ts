import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerHandle, Trail, AgentTask } from "@ephyra/core";
import { buildProof, collectSessions, ClaudeCodeAgent, CodexAgent } from "./index";

async function command(cwd: string, ...args: string[]) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit) throw new Error(`${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}
function fakeRunner(root: string): Runner {
  return {
    name: "fixture", capabilities: { checkpoint: "none", network: ["none"], shell: true, browser: false },
    async *exec(_handle, cmd, opts) {
      // Like real runners: cwd is relative to the sandbox workdir.
      const process = Bun.spawn(cmd, { cwd: opts.cwd ? join(root, opts.cwd) : root, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => process.kill(), opts.deadlineMs);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      clearTimeout(timer);
      yield { stream: "stdout", chunk: stdout };
      yield { stream: "stderr", chunk: stderr };
      yield { exit, durationMs: 0, timedOut: process.signalCode !== null };
    },
    async readFile(_handle, path) { try { return await readFile(join(root, path)); } catch { return null; } },
    async writeFile(_handle, path, data) { await writeFile(join(root, path), data); },
    async allocate() { throw new Error("unused"); }, async checkpoint() { throw new Error("unused"); },
    async restore() { throw new Error("unused"); }, async exportArtifacts() { throw new Error("unused"); },
    async destroy() { throw new Error("unused"); },
  };
}
const handle = (root: string): RunnerHandle => ({ id: "test", runner: "fixture", workdir: root,
  trailId: "test", attempt: 1, leaseExpiresAt: "2099-01-01T00:00:00Z" });

test("proof runs real probe and tests at both commits and collects actual trailers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ephyra-agent-"));
  try {
    await command(root, "git", "init", "-q");
    await command(root, "git", "config", "user.email", "test@example.test");
    await command(root, "git", "config", "user.name", "Test");
    await writeFile(join(root, "value.ts"), "export const value = 0;\n");
    await writeFile(join(root, "value.test.ts"), 'import {test,expect} from "bun:test";\n' +
      'import {value} from "./value";\ntest("value",()=>expect(value).toBe(1));\n');
    await command(root, "git", "add", ".");
    await command(root, "git", "commit", "-qm", "base");
    const base = await command(root, "git", "rev-parse", "HEAD");
    await writeFile(join(root, "value.ts"), "export const value = 1;\n");
    await command(root, "git", "add", ".");
    await command(root, "git", "commit", "-qm", "fix\n\nEntire-Checkpoint: observed-123");
    const head = await command(root, "git", "rev-parse", "HEAD");
    await mkdir(join(root, ".ephyra/repro"), { recursive: true });
    await writeFile(join(root, ".ephyra/repro/test.sh"), 'grep -q "value = 1" value.ts\n');
    const runner = fakeRunner(root);
    expect(await collectSessions(runner, handle(root), base, head, 10_000))
      .toEqual([{ provider: "entire", checkpoint: "observed-123" }]);
    const trail = { id: "018f0000-0000-7000-8000-000000000000", rev: 1, risk: "low" } as Trail;
    const proof = await buildProof({ runner, handle: handle(root), trail, base, head,
      probe: ".ephyra/repro/test.sh", testCommand: ["bun", "test"],
      evaluate: () => ({ passed: true, missing: [] }) });
    expect(proof.items.find(item => item.kind === "diff_scope"))
      .toEqual({ kind: "diff_scope", files: 1, lines: 2, paths: ["value.ts"], exportedTypesChanged: true });
    expect(proof.items.find(item => item.kind === "tests")).toMatchObject({ passed: 1, failed: 0, newFailures: 0 });
    expect(proof.items.map(item => item.kind)).toEqual(["repro_before", "repro_after", "tests", "diff_scope"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("both CLI adapters execute and capture usage and timeout is surfaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "ephyra-cli-"));
  try {
    await command(root, "git", "init", "-q");
    await command(root, "git", "config", "user.email", "test@example.test");
    await command(root, "git", "config", "user.name", "Test");
    await command(root, "git", "commit", "--allow-empty", "-qm", "base");
    const real = fakeRunner(root);
    const calls: string[][] = [];
    const runner: Runner = { ...real, async *exec(h, cmd, opts) {
      calls.push(cmd);
      if (cmd[0] === "claude" || cmd[0] === "codex") {
        const json = cmd[0] === "claude"
          ? JSON.stringify({ result: "ok", usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.001 })
          : JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } });
        yield { stream: "stdout", chunk: json };
        yield { exit: 0, durationMs: 1, timedOut: false };
      } else yield* real.exec(h, cmd, opts);
    } };
    const task = { step: "review", trail: { id: "x" }, context: {}, untrusted: {},
      budget: { tokens: 100, wallclockS: 10 } } as AgentTask;
    expect((await new ClaudeCodeAgent("c").run(task, runner, handle(root))).usage.tokens).toBe(5);
    expect((await new CodexAgent("d").run(task, runner, handle(root))).usage.tokens).toBe(5);
    expect(calls.some(call => call[0] === "codex" && call.includes("--json"))).toBe(true);
    const timeout: Runner = { ...runner, async *exec() { yield { exit: 1, durationMs: 1, timedOut: true }; } };
    await expect(new ClaudeCodeAgent("c").run(task, timeout, handle(root))).rejects.toThrow("deadline");
  } finally { await rm(root, { recursive: true, force: true }); }
});
