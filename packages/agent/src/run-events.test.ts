import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { AgentRunEvent, type AgentTask, type Runner, type RunnerHandle } from "@ephyra/core";
import {
  ClaudeCodeAgent, CodexAgent, LIMITS, LineFeed, claudeStreamNormalizer, clip, cliCommand, executorOf, normalizeStream, runAgent,
  type ExecutorInfo, type RunEventDraft,
} from "./index";
import { AmpAgent, MemoryAmpThreads } from "./amp";

const fixture = (name: string) => readFile(join(import.meta.dir, "../test/fixtures", name), "utf8");
const valid = (events: RunEventDraft[]) => events.forEach((e, i) => AgentRunEvent.parse({ ...e, runId: "r", seq: i, at: "2026-11-07T00:00:00.000Z" }));
const THREAD = "T-01a1b539-f083-765f-8b6b-9255cfec4fb5";

describe("stream-json (Amp and Claude Code)", () => {
  test("the real Amp reauthentication failure: a started status, no prompt echo, and a failed status with Amp's message", async () => {
    const events = normalizeStream("claude", await fixture("amp-error-reauth.jsonl"));
    expect(events.map((e) => e.type)).toEqual(["status", "status"]);
    expect(events[0]!.text).toBe("Session T-01a1b539-866f-77a3-833f-b417d7707bbd started (mode low)");
    expect(events[1]!.text).toContain("Failed (error_during_execution)");
    expect(events[1]!.text).toContain("reauthenticate your ChatGPT subscription");
    expect(JSON.stringify(events)).not.toContain("Read cart.js"); // the prompt is not part of the transcript
    valid(events);
  });

  test("a full turn: reasoning, text, redacted tool calls, paired results, errors, portal, result", async () => {
    const events = normalizeStream("claude", await fixture("amp-success-stream.jsonl"));
    expect(events.map((e) => e.type)).toEqual([
      "status", "reasoning", "message", "tool_call", "tool_result", "tool_call", "tool_result", "portal", "tool_call", "tool_result", "message", "status",
    ]);
    valid(events);
    const call = events[3]!.tool!;
    expect(call).toMatchObject({ callId: "tu_1", name: "shell_command" });
    expect(call.args).not.toContain("sk-live-abcdefghijklmnop");
    expect(events[4]!.tool).toMatchObject({ callId: "tu_1", name: "shell_command" });
    expect(events[4]!.tool!.result).not.toContain("abcdef1234567890");
    expect(events[4]!.tool!.isError).toBeUndefined();
    expect(events[9]!.tool).toMatchObject({ callId: "tu_3", isError: true });
    expect(events[7]).toMatchObject({ type: "portal", portalUrl: "https://3000-orb-abc123.portal.example.test/" });
    expect(events.at(-1)!.text).toBe("Finished (success)");
  });

  test("a portal is reported only when a portal command printed it", () => {
    const n = claudeStreamNormalizer();
    n.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "shell_command", input: { command: "curl https://x.test" } }] } }));
    const out = n.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "see https://example.test/page" }] } }));
    expect(out.map((e) => e.type)).toEqual(["tool_result"]);
  });

  test("the thread URL and portal reach onExecutor; non-JSON and unknown lines produce nothing", async () => {
    const seen: Partial<ExecutorInfo>[] = [];
    const n = claudeStreamNormalizer({ onExecutor: (p) => seen.push(p), threadUrl: (id) => `https://ampcode.com/threads/${id}` });
    const events = (await fixture("amp-success-stream.jsonl")).split("\n").filter(Boolean).flatMap((l) => n.push(l));
    expect(events.length).toBeGreaterThan(5);
    expect(seen).toEqual([{ threadUrl: `https://ampcode.com/threads/${THREAD}` }, { portalUrl: "https://3000-orb-abc123.portal.example.test/" }]);
    expect(n.push("not json")).toEqual([]);
    expect(n.push('{"type":"mystery"}')).toEqual([]);
  });

  test("everything is cut to the schema limits, whatever the engine sends", () => {
    fc.assert(fc.property(fc.string({ maxLength: 40_000 }), fc.integer({ min: 1, max: 30_000 }), (text, max) => {
      expect(clip(text, max).length).toBeLessThanOrEqual(max);
    }), { numRuns: 50 });
    const huge = "x".repeat(50_000);
    const n = claudeStreamNormalizer();
    const out = [
      ...n.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: huge }, { type: "tool_use", id: "t", name: "shell_command", input: { c: huge } }] } })),
      ...n.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: huge }] } })),
    ];
    expect(out[0]!.text!.length).toBeLessThanOrEqual(LIMITS.text);
    expect(out[1]!.tool!.args!.length).toBeLessThanOrEqual(LIMITS.args);
    expect(out[2]!.tool!.result!.length).toBeLessThanOrEqual(LIMITS.result);
    valid(out);
  });

  test("explicit secrets are scrubbed from every field", () => {
    const n = claudeStreamNormalizer({ secrets: ["hunter2hunter2"] });
    const out = n.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pw is hunter2hunter2" }, { type: "tool_use", id: "t", name: "sh", input: { p: "hunter2hunter2" } }] } }));
    expect(JSON.stringify(out)).not.toContain("hunter2hunter2");
  });

  test("LineFeed reassembles lines split across chunks", async () => {
    const text = await fixture("amp-success-stream.jsonl");
    const seen: RunEventDraft[] = [];
    const feed = new LineFeed(claudeStreamNormalizer(), (e) => { seen.push(e); });
    for (let i = 0; i < text.length; i += 37) await feed.write(text.slice(i, i + 37));
    await feed.finish();
    expect(seen).toEqual(normalizeStream("claude", text));
  });
});

describe("Codex --json", () => {
  test("commands, patches and tool calls become paired calls and results; unknown items are skipped", async () => {
    const events = normalizeStream("codex", await fixture("codex-events.jsonl"));
    valid(events);
    expect(events.map((e) => e.type)).toEqual([
      "status", "reasoning", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "message", "status",
    ]);
    expect(events[2]!.tool).toMatchObject({ callId: "item_1", name: "shell" });
    expect(events[3]!.tool).toMatchObject({ callId: "item_1", name: "shell" });
    expect(events[5]!.tool).toMatchObject({ callId: "item_2", isError: true });
    expect(events[5]!.tool!.result).not.toContain("ghp_abcdefghijklmnop123456");
    expect(events[6]!.tool!.name).toBe("apply_patch");
    expect(events[8]!.tool).toMatchObject({ name: "entire.search" });
    expect(events[10]!.text).toBe("Fixed: an empty cart now totals 0.");
    expect(events.filter((e) => e.tool?.callId === "item_1" && e.type === "tool_call")).toHaveLength(1); // started + completed → one call
  });
});

describe("agents report events while they run", () => {
  const task: AgentTask = { step: "research", trail: { id: "01a1b539-866f-77a3-833f-b417d7707bbd", short: "T-07bbd0", title: "x" } as never,
    untrusted: {}, context: {}, budget: { tokens: 1000, wallclockS: 30 } };
  /** A runner that streams `chunks` for the agent command and a fixed HEAD for git. */
  const runnerFor = (chunks: string[]): Runner => ({
    name: "fake", capabilities: { checkpoint: "none", network: ["none"], shell: true, browser: false },
    async *exec(_h, cmd) {
      if (cmd[0] === "git") { yield { stream: "stdout" as const, chunk: `${"a".repeat(40)}\n` }; yield { exit: 0, durationMs: 1, timedOut: false }; return; }
      for (const c of chunks) yield { stream: "stdout" as const, chunk: c };
      yield { exit: 0, durationMs: 1, timedOut: false };
    },
    async readFile() { return new TextEncoder().encode("# hypothesis"); }, async writeFile() {},
    async allocate() { throw new Error("unused"); }, async checkpoint() { throw new Error("unused"); }, async restore() { throw new Error("unused"); },
    async exportArtifacts() { return []; }, async destroy() { return { destroyed: true, at: "" }; },
  });
  const handle = { id: "h", runner: "fake", workdir: "/w", trailId: task.trail.id, attempt: 1, leaseExpiresAt: "" } as RunnerHandle;

  test("Amp: events arrive in order as the stream arrives, the result is unchanged, and the executor is described", async () => {
    const text = await fixture("amp-success-stream.jsonl");
    const chunks = text.match(/[\s\S]{1,200}/g)!;
    const agent = new AmpAgent({ executor: { kind: "orb", project: "dio/shop" }, threads: new MemoryAmpThreads() });
    expect(executorOf(agent)).toEqual({ kind: "orb", project: "dio/shop" });
    const events: RunEventDraft[] = [];
    const patches: Partial<ExecutorInfo>[] = [];
    const withEvents = await runAgent(agent, task, runnerFor(chunks), handle, { onEvent: (e) => { events.push(e); }, onExecutor: (p) => patches.push(p) });
    const without = await new AmpAgent({ executor: { kind: "orb", project: "dio/shop" }, threads: new MemoryAmpThreads() }).run(task, runnerFor(chunks), handle);
    expect(withEvents).toEqual(without);
    expect(events).toEqual(normalizeStream("claude", text));
    expect(patches[0]).toEqual({ threadUrl: `https://ampcode.com/threads/${THREAD}` });
    expect(executorOf(new AmpAgent({ executor: { kind: "runner", runnerId: "nix-box" }, threads: new MemoryAmpThreads() }))).toEqual({ kind: "runner", id: "nix-box" });
  });

  test("Claude Code asks for stream-json only when someone is listening, and still reads usage from the result line", async () => {
    expect(cliCommand("claude", "m", task)).toContain("json");
    expect(cliCommand("claude", "m", task)).not.toContain("--verbose");
    expect(cliCommand("claude", "m", task, true).slice(1, 5)).toEqual(["--print", "--output-format", "stream-json", "--verbose"]);
    const stream = (await fixture("amp-success-stream.jsonl")).replace('"usage":{"input_tokens":900,"output_tokens":100}', '"usage":{"input_tokens":900,"output_tokens":100},"total_cost_usd":0.5');
    const events: RunEventDraft[] = [];
    const result = await runAgent(new ClaudeCodeAgent("claude-opus-5-5"), task, runnerFor([stream]), handle, { onEvent: (e) => { events.push(e); } });
    expect(result.usage).toEqual({ tokens: 1000, costMicrousd: 500_000, model: "claude-opus-5-5" });
    expect(events.at(-1)!.text).toBe("Finished (success)");
  });

  test("Codex streams its events and keeps the same result", async () => {
    const text = await fixture("codex-events.jsonl");
    const events: RunEventDraft[] = [];
    const result = await runAgent(new CodexAgent("gpt-6.1-sol"), task, runnerFor([text]), handle, { onEvent: (e) => { events.push(e); } });
    expect(result.usage).toEqual({ tokens: 150, costMicrousd: null, model: "gpt-6.1-sol" });
    expect(events.map((e) => e.type)).toEqual(normalizeStream("codex", text).map((e) => e.type));
  });
});
