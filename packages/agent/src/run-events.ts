// Normalizers from engine streams to the console's AgentRunEvent (without runId/seq/at: the server stamps those).
// Amp and Claude Code speak the same stream-json; Codex `exec --json` is its own JSONL. Everything that reaches an event is redacted
// and cut to the schema limits. A line that is not JSON, or an event type we do not know, produces nothing: nothing is invented.
import type { AgentRunEvent } from "@ephyra/core";
import { redact } from "./redact";

export type RunEventDraft = Omit<AgentRunEvent, "runId" | "seq" | "at"> & { at?: string };
export type ExecutorInfo = {
  kind: "orb" | "runner" | "local" | "railway" | "notorganic";
  id?: string; project?: string; portalUrl?: string; threadUrl?: string;
};
/** What a streaming agent is given to report progress. All optional; an agent that ignores it still returns the same AgentResult. */
export type AgentRunOptions = {
  signal?: AbortSignal;
  /** Actual usage is reported before validating products, including turns whose products are unusable. */
  onUsage?: (usage: { key: string; tokens: number | null; costMicrousd: number | null; model: string }) => void | Promise<void>;
  onEvent?: (event: RunEventDraft) => void | Promise<void>;
  /** Details of where the run executes that only become known during the run (Amp thread URL, portal URL). */
  onExecutor?: (patch: Partial<ExecutorInfo>) => void;
  /** Exact secret values to scrub from everything reported, in addition to the pattern-based redaction. */
  secrets?: string[];
};
export const LIMITS = { text: 20000, args: 4000, result: 8000 } as const;

const TRUNCATED = "\n[truncated]";
/** Redact, then cut to `max` characters including the marker. */
export function clip(text: string, max: number, secrets: string[] = []): string {
  const clean = redact(text, secrets, Number.MAX_SAFE_INTEGER);
  if (clean.length <= max) return clean;
  return max <= TRUNCATED.length ? clean.slice(0, max) : clean.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

type Json = Record<string, any>;
export interface StreamNormalizer {
  /** One line of output. */
  push(line: string): RunEventDraft[];
  /** Whatever the stream left open when it ended. */
  end(): RunEventDraft[];
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? String(c.text ?? "") : stringify(c))).join("\n");
  return content == null ? "" : stringify(content);
}

const URL_RE = /https:\/\/[^\s"'<>)\]]+/;
/** Only a command that asks for a portal can report one. */
const asksForPortal = (name: string, args: string) => /shell|bash|command/i.test(name) && /orb\s+portal|--portal/.test(args);

/** Claude Code `--output-format stream-json` and Amp `--stream-json`. */
export function claudeStreamNormalizer(options: Pick<AgentRunOptions,
  "onExecutor" | "secrets"> & { threadUrl?: (id: string) => string | undefined } = {}): StreamNormalizer {
  const secrets = options.secrets ?? [];
  const tools = new Map<string, { name: string; portal: boolean }>();
  return {
    push(line) {
      let m: Json;
      try { m = JSON.parse(line); } catch { return []; }
      if (!m || typeof m !== "object") return [];
      const out: RunEventDraft[] = [];
      if (m.type === "system" && m.subtype === "init") {
        const id = typeof m.session_id === "string" ? m.session_id : undefined;
        const url = id ? options.threadUrl?.(id) : undefined;
        if (url) options.onExecutor?.({ threadUrl: url });
        const mode = typeof m.agent_mode === "string" ? ` (mode ${m.agent_mode})` : "";
        out.push({ type: "status", text: clip(`Session ${id ?? ""} started${mode}`.replace("  ", " "), LIMITS.text, secrets) });
      } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message.content as Json[]) {
          if (block.type === "text" && String(block.text ?? "").trim()) out.push({ type: "message", text: clip(String(block.text), LIMITS.text, secrets) });
          else if (block.type === "thinking" && String(block.thinking ?? block.text ?? "").trim()) {
            out.push({ type: "reasoning", text: clip(String(block.thinking ?? block.text), LIMITS.text, secrets) });
          } else if (block.type === "tool_use") {
            const callId = String(block.id ?? `call-${tools.size + 1}`);
            const name = String(block.name ?? "tool");
            const args = clip(stringify(block.input ?? {}), LIMITS.args, secrets);
            tools.set(callId, { name, portal: asksForPortal(name, args) });
            out.push({ type: "tool_call", tool: { callId, name, args } });
          }
        }
      } else if (m.type === "user" && Array.isArray(m.message?.content)) {
        // The user turn that carries the prompt is skipped on purpose (it holds quoted signal text); tool results are the interesting part.
        for (const block of m.message.content as Json[]) {
          if (block.type !== "tool_result") continue;
          const callId = String(block.tool_use_id ?? "");
          const known = tools.get(callId);
          const raw = textOf(block.content);
          out.push({
            type: "tool_result",
            tool: { callId, name: known?.name ?? "tool", result: clip(raw, LIMITS.result, secrets), ...(block.is_error ? { isError: true } : {}) },
          });
          const url = known?.portal && !block.is_error ? URL_RE.exec(raw)?.[0] : undefined;
          if (url) { options.onExecutor?.({ portalUrl: url }); out.push({ type: "portal", portalUrl: url, text: "Live preview available" }); }
        }
      } else if (m.type === "result") {
        const failed = m.is_error === true;
        const why = failed ? `: ${textOf(m.error ?? m.result ?? m.subtype)}` : "";
        out.push({ type: "status", text: clip(`${failed ? "Failed" : "Finished"} (${m.subtype ?? "result"})${why}`, LIMITS.text, secrets) });
      }
      return out;
    },
    end: () => [],
  };
}

/** Codex `exec --json` events (thread/turn/item). */
export function codexNormalizer(options: Pick<AgentRunOptions, "secrets"> = {}): StreamNormalizer {
  const secrets = options.secrets ?? [];
  const started = new Set<string>();
  const call = (item: Json): RunEventDraft | null => {
    const callId = String(item.id ?? "");
    if (item.type === "command_execution") return { type: "tool_call", tool: { callId, name: "shell", args: clip(stringify({ command: item.command }),
      LIMITS.args, secrets) } };
    if (item.type === "mcp_tool_call") {
      return { type: "tool_call", tool: { callId, name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, args: clip(stringify(item.arguments ?? {}),
        LIMITS.args, secrets) } };
    }
    if (item.type === "file_change") return { type: "tool_call", tool: { callId, name: "apply_patch", args: clip(stringify(item.changes ?? []), LIMITS.args,
      secrets) } };
    if (item.type === "web_search") return { type: "tool_call", tool: { callId, name: "web_search", args: clip(stringify({ query: item.query }), LIMITS.args,
      secrets) } };
    return null;
  };
  const result = (item: Json): RunEventDraft | null => {
    const callId = String(item.id ?? "");
    if (item.type === "command_execution") {
      const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
      return { type: "tool_result", tool: { callId, name: "shell", result: clip(String(item.aggregated_output ?? ""), LIMITS.result, secrets),
        ...(failed ? { isError: true } : {}) } };
    }
    if (item.type === "mcp_tool_call") {
      const failed = item.status === "failed" || Boolean(item.error);
      return { type: "tool_result", tool: { callId, name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
        result: clip(textOf(item.error?.message ?? item.result ?? ""), LIMITS.result, secrets), ...(failed ? { isError: true } : {}) } };
    }
    if (item.type === "file_change") {
      const failed = item.status === "failed";
      return { type: "tool_result", tool: { callId, name: "apply_patch", result: clip(failed ? "The patch failed" : "Applied", LIMITS.result, secrets),
        ...(failed ? { isError: true } : {}) } };
    }
    if (item.type === "web_search") return { type: "tool_result", tool: { callId, name: "web_search", result: "Done" } };
    return null;
  };
  return {
    push(line) {
      let e: Json;
      try { e = JSON.parse(line); } catch { return []; }
      const item = e?.item as Json | undefined;
      switch (e?.type) {
        case "thread.started": return [{ type: "status", text: clip(`Codex thread ${e.thread_id ?? ""} started`.replace("  ", " "), LIMITS.text, secrets) }];
        case "item.started": {
          const c = item ? call(item) : null;
          if (c && item) started.add(String(item.id));
          return c ? [c] : [];
        }
        case "item.completed": {
          if (!item) return [];
          if (item.type === "agent_message" && String(item.text ?? "").trim()) return [{ type: "message", text: clip(String(item.text), LIMITS.text,
            secrets) }];
          if (item.type === "reasoning" && String(item.text ?? "").trim()) return [{ type: "reasoning", text: clip(String(item.text), LIMITS.text, secrets) }];
          const out: RunEventDraft[] = [];
          if (!started.has(String(item.id))) { const c = call(item); if (c) out.push(c); }
          const r = result(item);
          if (r) out.push(r);
          return out;
        }
        case "turn.completed": return [{ type: "status", text: "Turn completed" }];
        case "turn.failed": return [{ type: "status", text: clip(`Failed: ${textOf(e.error?.message ?? "the turn failed")}`, LIMITS.text, secrets) }];
        case "error": return [{ type: "status", text: clip(`Error: ${textOf(e.message ?? "unknown")}`, LIMITS.text, secrets) }];
        default: return [];
      }
    },
    end: () => [],
  };
}

/** Feeds raw output chunks to a normalizer line by line (chunks can split a line anywhere). */
export class LineFeed {
  private buffer = "";
  constructor(private readonly normalizer: StreamNormalizer, private readonly emit: (e: RunEventDraft) => void | Promise<void>) {}
  async write(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) for (const e of this.normalizer.push(line)) await this.emit(e);
  }
  async finish(): Promise<void> {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) for (const e of this.normalizer.push(rest)) await this.emit(e);
    for (const e of this.normalizer.end()) await this.emit(e);
  }
}

/** Normalize a whole captured stream (tests, replays). */
export function normalizeStream(kind: "claude" | "codex", text: string, options: Pick<AgentRunOptions, "secrets"> = {}): RunEventDraft[] {
  const n = kind === "codex" ? codexNormalizer(options) : claudeStreamNormalizer(options);
  return [...text.split("\n").filter((l) => l.trim()).flatMap((l) => n.push(l)), ...n.end()];
}

/** An agent that can report events while it runs. The core `CodingAgent` shape is unchanged; `opts` is an optional extra argument. */
export interface StreamingAgent {
  readonly name: string;
  executor?(): ExecutorInfo;
  run(task: import("@ephyra/core").AgentTask, runner: import("@ephyra/core").Runner, handle: import("@ephyra/core").RunnerHandle,
    opts?: AgentRunOptions): Promise<import("@ephyra/core").AgentResult>;
}
/** Runs any `CodingAgent`, passing the options along (agents that don't stream ignore them). */
export function runAgent(agent: import("@ephyra/core").CodingAgent, task: import("@ephyra/core").AgentTask,
  runner: import("@ephyra/core").Runner, handle: import("@ephyra/core").RunnerHandle, opts: AgentRunOptions) {
  return (agent as StreamingAgent).run(task, runner, handle, opts);
}
/** Where the agent says it executes, or null when it doesn't say. */
export function executorOf(agent: import("@ephyra/core").CodingAgent): ExecutorInfo | null {
  return (agent as StreamingAgent).executor?.() ?? null;
}
