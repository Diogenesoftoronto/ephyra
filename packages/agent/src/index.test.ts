import { test, expect } from "bun:test";
import fc from "fast-check";
import type { AgentTask } from "@ephyra/core";
import { cliCommand, renderPrompt, MockAgent, ClaudeCodeAgent } from "./index";
const task = { step: "research", trail: { id: "123" }, context: {}, untrusted: {}, budget: { tokens: 100, wallclockS: 1 } } as AgentTask;
test("untrusted content cannot close its wrapper", () => {
  fc.assert(fc.property(fc.string(), value => {
    const prompt = renderPrompt({ ...task, untrusted: { signal: value } });
    const start = prompt.indexOf("<untrusted_signal>");
    const body = prompt.slice(start + "<untrusted_signal>".length, -"</untrusted_signal>".length);
    expect(body).not.toContain("<");
    expect(body).not.toContain(">");
  }));
});
test("CLI flags select model and noninteractive output", () => {
  expect(cliCommand("claude", "model-a", task)).toContain("--print");
  expect(cliCommand("claude", "model-a", task)).toContain("json");
  expect(cliCommand("codex", "model-b", task)).toContain("--json");
  expect(cliCommand("codex", "model-b", task)).toContain("model-b");
});
test("script exhaustion and unsupported budgets fail closed", async () => {
  await expect(new MockAgent([]).run()).rejects.toThrow();
  await expect(new ClaudeCodeAgent("model").run(task, {} as never, {} as never)).rejects.toThrow("token budget");
});

test("malformed review output is a typed failure", async () => {
  const { reviewStep, ReviewOutputError } = await import("./review");
  const runner = {
    async *exec() {
      yield { stream: "stdout" as const, chunk: "diff" };
      yield { exit: 0, durationMs: 1, timedOut: false };
    },
  };
  const agent = new MockAgent([{
    ok: true, artefacts: { "review.json": "not json" }, outputs: {},
    usage: { tokens: 0, costMicrousd: null, model: "mock" }, sessions: [],
  }]);
  await expect(reviewStep(agent, task, runner as never, {} as never, "a".repeat(40), "b".repeat(40)))
    .rejects.toBeInstanceOf(ReviewOutputError);
});
