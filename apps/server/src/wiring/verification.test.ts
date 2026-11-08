import { expect, test } from "bun:test";
import fc from "fast-check";
import { Unverified, type ProofItem, type Runner, type RunnerHandle, type Trail } from "@ephyra/core";
import type { ProofEvidenceContext } from "@ephyra/agent";
import { createVerificationCollector, runVerificationCommand, type BoundProofEvidence } from "./verification.ts";
import { executeProbe, type ProbeDefinition } from "./probes.ts";

const base = "a".repeat(40), head = "b".repeat(40);
const trail = { id: "00000000-0000-4000-8000-000000000001", rev: 2, area: "application", base: { sha: base }, head } as Trail;
const handle = { id: "fixture", workdir: "/workspace" } as RunnerHandle;
const source = { commit: head, path: "intents/application.md", digest: `sha256:${"c".repeat(64)}` };
const probe = (kind: "intent" | "regression", command: string[]): ProbeDefinition => ({
  id: `${kind}:example`, kind, command, paths: [], source,
});
function fixture(exit = 0, output = "observed fixture") {
  const calls: Array<{ command: string[]; cwd?: string }> = [];
  const runner = { name: "fixture", readFile: async () => null, writeFile: async () => {},
    async *exec(_handle: RunnerHandle, command: string[], opts: { cwd?: string }) {
      calls.push({ command, cwd: opts.cwd });
      yield { stream: "stdout" as const, chunk: output };
      yield { exit, durationMs: 1, timedOut: false };
    } } as unknown as Runner;
  const context: ProofEvidenceContext = { runner, handle, trail, base, head,
    baseCwd: ".proof-base", headCwd: ".proof-head", remainingMs: () => 1000, items: [] };
  return { context, runner, calls };
}
const bound = (items: ProofItem[]): BoundProofEvidence => ({ trailId: trail.id, rev: trail.rev, base, head,
  operationKey: "actual-provider-operation", source: "fixture/provider", items });

test("proof collection executes actual intent/regression commands and validates an actual review", async () => {
  const f = fixture();
  let reviewed = false;
  const receipts: unknown[] = [];
  const collect = createVerificationCollector({ catalog: { list: async () => [probe("intent", ["intent"]), probe("regression", ["regression"])] },
    review: async context => {
      expect(context.head).toBe(head); reviewed = true;
      return { kind: "bug_review", reviewer: "fixture/reviewer", findings: [] };
    }, onReceipts: async (_ctx, values) => { receipts.push(...values); } });
  expect(await collect(f.context)).toEqual([
    { kind: "regression_probes", ran: ["regression:example"], failed: [] },
    { kind: "intent_probes", ran: ["intent:example"], failed: [] },
    { kind: "bug_review", reviewer: "fixture/reviewer", findings: [] },
  ]);
  expect(reviewed).toBe(true); expect(receipts).toHaveLength(2);
  expect(f.calls).toEqual([{ command: ["regression"], cwd: ".proof-head" }, { command: ["intent"], cwd: ".proof-head" }]);
});

test("missing probes and missing sources never produce passing empty evidence", async () => {
  const f = fixture();
  expect(await createVerificationCollector({ catalog: { list: async () => [] } })(f.context)).toEqual([]);
  expect(f.calls).toHaveLength(0);
  const fail = fixture(1);
  const items = await createVerificationCollector({ catalog: { list: async () => [probe("intent", ["observed-failure"])] } })(fail.context);
  expect(items).toEqual([{ kind: "intent_probes", ran: ["intent:example"], failed: ["intent:example"] }]);
});

test("a first repair seeds regression coverage by actually rerunning its exact repro in the prepared head", async () => {
  const f = fixture();
  const writes: Array<{ path: string; content: string | Uint8Array }> = [];
  f.runner.readFile = async () => new TextEncoder().encode("test -f src/value.ts\n");
  f.runner.writeFile = async (_handle, path, content) => { writes.push({ path, content }); };
  f.context.items = [{ kind: "repro_before", probe: ".ephyra/repro/value.sh", result: "fail", log: "observed" },
    { kind: "repro_after", probe: ".ephyra/repro/value.sh", result: "pass", log: "observed" }];
  const items = await createVerificationCollector({ catalog: { list: async () => [] } })(f.context);
  expect(items).toEqual([{ kind: "regression_probes", ran: [`regression:current:${trail.id}:${trail.rev}`], failed: [] }]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.command[0]).toBe("sh"); expect(f.calls[0]!.cwd).toBe(".proof-head");
  expect(writes).toHaveLength(1); expect(writes[0]!.content).toBe("test -f src/value.ts\n");
});

test("provider evidence is bound to the exact trail/revision/base/head before it enters proof", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async field => {
    const f = fixture();
    const receipt = bound([{ kind: "persona_study", study: "actual-study", runId: "actual-run", synthetic: true, report: "observed" }]);
    if (field === 0) receipt.trailId = crypto.randomUUID();
    if (field === 1) receipt.rev++;
    if (field === 2) receipt.base = head;
    if (field === 3) receipt.head = base;
    const collect = createVerificationCollector({ catalog: { list: async () => [] }, sources: async () => [receipt] });
    await expect(collect(f.context)).rejects.toBeInstanceOf(Unverified);
  }), { numRuns: 20 });
});

test("UI/replay collectors must run, return an exact report and cannot claim human studies", async () => {
  const report = { schema: 1, trailId: trail.id, rev: trail.rev, base, head,
    items: [{ kind: "story_render" as const, surface: "web" as const, stories: ["Checkout"], failed: [], uncovered: [] }] };
  const f = fixture(0, JSON.stringify(report));
  const command = { id: "story-render", command: ["bun", "run", "proof:stories"], kinds: ["story_render" as const] };
  const receipt = await runVerificationCommand(f.context, command);
  expect(receipt.items).toEqual(report.items);
  expect(f.calls).toEqual([{ command: command.command, cwd: ".proof-head" }]);
  await expect(runVerificationCommand(fixture(1, JSON.stringify(report)).context, command)).rejects.toBeInstanceOf(Unverified);
  const forged = fixture(0, JSON.stringify({ ...report, head: base }));
  await expect(runVerificationCommand(forged.context, command)).rejects.toBeInstanceOf(Unverified);
  const human = fixture(0, JSON.stringify({ ...report, items: [{ kind: "persona_study", study: "claim", runId: "claim",
    synthetic: true, report: "claim" }] }));
  await expect(runVerificationCommand(human.context, command)).rejects.toBeInstanceOf(Unverified);
});

test("a process without a confirmed outcome or with excessive output is unavailable rather than a failed/pass receipt", async () => {
  for (const scenario of ["missing-exit", "timeout", "oversized"]) {
    const f = fixture();
    f.runner.exec = async function* () {
      if (scenario === "oversized") yield { stream: "stdout", chunk: "x".repeat(256001) };
      if (scenario === "timeout") yield { exit: 0, durationMs: 1, timedOut: true };
    };
    await expect(executeProbe(probe("intent", ["actual-command"]), { runner: f.runner, handle,
      remainingMs: () => 1000 })).rejects.toBeInstanceOf(Unverified);
  }
});
