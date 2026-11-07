import { Unverified, type AgentTask, type AgentResult, type CodingAgent, type Runner, type RunnerHandle } from "@ephyra/core";
import { renderPrompt } from "./prompts";
import { execute } from "./execute";
import { collectSessions } from "./sessions";
import { LineFeed, claudeStreamNormalizer, codexNormalizer, type AgentRunOptions, type ExecutorInfo } from "./run-events";

/** `stream` asks Claude Code for stream-json (needed to watch a run live); the result line carries the same usage as the single JSON object. */
export function cliCommand(provider: "claude" | "codex", model: string, task: AgentTask, stream = false): string[] {
  const prompt = renderPrompt(task);
  return provider === "claude"
    ? ["claude", "--print", "--output-format", ...(stream ? ["stream-json", "--verbose"] : ["json"]), "--model", model, "--permission-mode",
      task.step === "review" ? "plan" : "acceptEdits", prompt]
    : ["codex", "exec", "--json", "--model", model, "--sandbox",
      task.step === "review" ? "read-only" : "workspace-write", prompt];
}

type Event = Record<string, any>;
function parseOutput(provider: "claude" | "codex", stdout: string, model: string, stream = false) {
  let events: Event[];
  try {
    events = provider === "claude" && !stream ? [JSON.parse(stdout)] : stdout.trim().split("\n").map(line => JSON.parse(line));
  } catch {
    throw new Unverified("agent JSON output");
  }
  const completion = provider === "claude" ? (stream ? events.find(event => event.type === "result") : events[0]) : events.find(event => event.type === "turn.completed");
  const usage = completion?.usage;
  if (!usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
    throw new Unverified("agent usage");
  }
  const tokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  const cost = completion.total_cost_usd;
  const text = provider === "claude" ? completion.result : events
    .filter(event => event.type === "item.completed" && event.item?.type === "agent_message")
    .map(event => event.item.text).join("\n");
  return { tokens, costMicrousd: typeof cost === "number" ? Math.round(cost * 1_000_000) : null, text, model };
}

abstract class CliAgent implements CodingAgent {
  abstract readonly name: string;
  abstract readonly provider: "claude" | "codex";
  constructor(readonly model: string) {}
  /** The CLI agents run in whatever runner they are given; the server names the executor from the runner. */
  executor(): ExecutorInfo { return { kind: "local" }; }
  async run(task: AgentTask, runner: Runner, handle: RunnerHandle, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const end = Date.now() + task.budget.wallclockS * 1000;
    const remaining = () => {
      const ms = end - Date.now();
      if (ms <= 0) throw new Unverified("agent deadline exceeded");
      return ms;
    };
    const before = await execute(runner, handle, ["git", "rev-parse", "HEAD"], remaining());
    if (before.exit !== 0) throw new Unverified("agent base commit");
    const stream = Boolean(opts.onEvent);
    const feed = opts.onEvent
      ? new LineFeed(this.provider === "codex" ? codexNormalizer(opts.secrets ? { secrets: opts.secrets } : {})
        : claudeStreamNormalizer(opts.secrets ? { secrets: opts.secrets } : {}), opts.onEvent)
      : null;
    const run = await execute(runner, handle, cliCommand(this.provider, this.model, task, stream), remaining(), undefined, feed ? (c) => feed.write(c) : undefined);
    await feed?.finish();
    if (run.exit !== 0) throw new Unverified("agent CLI failure");
    const usage = parseOutput(this.provider, run.stdout, this.model, stream);
    const after = await execute(runner, handle, ["git", "rev-parse", "HEAD"], remaining());
    if (after.exit !== 0) throw new Unverified("agent head commit");
    const base = before.stdout.trim();
    const head = after.stdout.trim();
    const sessions = await collectSessions(runner, handle, base, head, remaining());
    const artefacts: Record<string, string> = {};
    const outputs: Record<string, string> = {};
    const path = task.step === "research" ? "hypothesis.md" : task.step === "plan" ? "plan.md" : undefined;
    if (path) {
      const data = await runner.readFile(handle, path);
      if (data) artefacts[path] = new TextDecoder().decode(data);
    }
    if (task.step === "review") artefacts["review.json"] = usage.text;
    if (task.step === "patch") {
      if (base === head) throw new Unverified("patch produced no commits");
      const log = await execute(runner, handle,
        ["git", "log", "--format=%H%x00%(trailers)%x00", `${base}..${head}`], remaining());
      if (log.exit !== 0) throw new Unverified("patch commit trailers");
      const parts = log.stdout.split("\0");
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const trailers = parts[i + 1]!.split("\n").map(line => line.trim());
        if (!trailers.includes(`Ephyra-Trail: ${task.trail.id}`)) throw new Unverified("patch trail trailer");
      }
      outputs.head = head;
    }
    if (task.step === "repro") {
      const listing = await execute(runner, handle, ["git", "ls-files", "--cached", "--others", "--exclude-standard",
        "--", ".ephyra/repro"], remaining());
      const paths = listing.stdout.trim().split("\n").filter(path => /^\.ephyra\/repro\/[^/]+\.sh$/.test(path));
      if (listing.exit !== 0 || paths.length !== 1) throw new Unverified("repro artefact");
      const data = await runner.readFile(handle, paths[0]!);
      if (!data) throw new Unverified("repro artefact");
      artefacts[paths[0]!] = new TextDecoder().decode(data);
      outputs.probe = paths[0]!;
    }
    return { ok: true, artefacts, outputs, usage: { tokens: usage.tokens, costMicrousd: usage.costMicrousd,
      model: usage.model }, sessions };
  }
}
export class ClaudeCodeAgent extends CliAgent { readonly name = "claude-code"; readonly provider = "claude" as const; }
export class CodexAgent extends CliAgent { readonly name = "codex"; readonly provider = "codex" as const; }
