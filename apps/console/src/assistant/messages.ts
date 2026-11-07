// Pure converters from Ephyra data to assistant-ui messages. No React, no I/O: the ExternalStoreRuntime adapters in
// useVelumRuntime / useRunRuntime feed these results to assistant-ui, so the transcript is always a function of the
// data the server returned.
import type { AgentRun, AgentRunEvent, AreaSketch, DraftMessage } from "@ephyra/core";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { FORM_PREFIX } from "../lib/protocol.ts";

export type PolicyNote = NonNullable<AgentRunEvent["policy"]>;
/** Extra data a tool-call part carries beyond assistant-ui's own fields (stored in its `artifact`). */
export type ToolArtifact = { policy: PolicyNote[]; at: string };

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolPart = Extract<Part, { type: "tool-call" }>;

// ───────────────────────── Velum draft thread ─────────────────────────

/** How a human message is shown. A message the console sends for an edited form is summarised, not dumped as JSON. */
export function displayHumanText(text: string): string {
  if (text.startsWith(FORM_PREFIX)) {
    try {
      const values =
        (JSON.parse(text.slice(FORM_PREFIX.length)) as { values?: Record<string, unknown> }).values ?? {};
      const n = Object.keys(values).length;
      return n ? `Applied the form (${n} value${n === 1 ? "" : "s"}).` : "Applied the form.";
    } catch {
      return "Applied the form.";
    }
  }
  return text;
}

export type FormPartData = { messageId: string; spec: unknown };
export type ProposalPartData = {
  messageId: string;
  summary: string;
  content: string;
  warnings: string[];
  sketches?: AreaSketch[];
};

export function draftToThread(messages: readonly DraftMessage[], pendingText?: string): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = messages.map((m): ThreadMessageLike => {
    const createdAt = new Date(m.at);
    if (m.role === "human") {
      return {
        id: m.id,
        role: "user",
        createdAt,
        content: [{ type: "text", text: displayHumanText(m.text) }],
        metadata: { custom: { author: m.author } },
      };
    }
    if (m.role === "system") return { id: m.id, role: "system", createdAt, content: m.text };
    const parts: Part[] = [{ type: "text", text: m.text }];
    if (m.spec !== undefined)
      parts.push({ type: "data-form", data: { messageId: m.id, spec: m.spec } satisfies FormPartData });
    if (m.proposal) {
      const { content, summary, warnings, sketches } = m.proposal;
      parts.push({
        type: "data-proposal",
        data: { messageId: m.id, content, summary, warnings, sketches } satisfies ProposalPartData,
      });
    }
    return {
      id: m.id,
      role: "assistant",
      createdAt,
      status: { type: "complete", reason: "stop" },
      content: parts,
      metadata: { custom: { persona: m.persona ?? "velum", usage: m.usage } },
    };
  });
  if (pendingText !== undefined) {
    out.push({
      id: "pending-human",
      role: "user",
      content: [{ type: "text", text: displayHumanText(pendingText) }],
      metadata: { custom: { pending: true } },
    });
  }
  return out;
}

// ───────────────────────── Agent run transcript ─────────────────────────

function parseArgs(text: string | undefined): ToolPart["args"] {
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as ToolPart["args"])
      : { value: v as never };
  } catch {
    return {};
  }
}

/**
 * One assistant message holds the whole run, in order: text, reasoning, tool calls (with their result and any plugin
 * decisions), status lines and portal links. A result or a decision joins the tool call with the same `callId`.
 */
export function eventsToThread(
  events: readonly AgentRunEvent[],
  run: Pick<AgentRun, "status" | "startedAt">,
): ThreadMessageLike[] {
  const parts: Part[] = [];
  const calls = new Map<string, number>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const attach = (e: AgentRunEvent, patch: (p: ToolPart) => ToolPart): boolean => {
    // The server sends an empty callId when a plugin decision does not say which call it was about.
    const at = e.tool && e.tool.callId !== "" ? calls.get(e.tool.callId) : undefined;
    if (at === undefined) return false;
    parts[at] = patch(parts[at] as ToolPart);
    return true;
  };
  for (const e of sorted) {
    if (e.type === "message" && e.text) parts.push({ type: "text", text: e.text });
    else if (e.type === "reasoning" && e.text) parts.push({ type: "reasoning", text: e.text });
    else if (e.type === "status") parts.push({ type: "data-status", data: { text: e.text ?? "", at: e.at } });
    else if (e.type === "portal" && e.portalUrl)
      parts.push({ type: "data-portal", data: { url: e.portalUrl, text: e.text, at: e.at } });
    else if (e.type === "tool_call" && e.tool) {
      calls.set(e.tool.callId, parts.length);
      parts.push({
        type: "tool-call",
        toolCallId: e.tool.callId,
        toolName: e.tool.name,
        args: parseArgs(e.tool.args),
        argsText: e.tool.args ?? "{}",
        artifact: { policy: [], at: e.at } satisfies ToolArtifact,
      });
    } else if (e.type === "tool_result" && e.tool) {
      const done = attach(e, (p) => ({
        ...p,
        result: e.tool!.result ?? "",
        isError: e.tool!.isError ?? false,
      }));
      if (!done)
        parts.push({
          type: "tool-call",
          toolCallId: e.tool.callId,
          toolName: e.tool.name,
          args: {},
          argsText: "{}",
          result: e.tool.result ?? "",
          isError: e.tool.isError ?? false,
          artifact: { policy: [], at: e.at } satisfies ToolArtifact,
        });
    } else if (e.type === "policy" && e.policy) {
      const policy = e.policy;
      const done = attach(e, (p) => ({
        ...p,
        artifact: {
          ...(p.artifact as ToolArtifact),
          policy: [...(p.artifact as ToolArtifact).policy, policy],
        },
      }));
      if (!done) parts.push({ type: "data-policy", data: { ...policy, tool: e.tool?.name, at: e.at } });
    }
  }
  if (parts.length === 0) return [];
  return [
    {
      id: `run-${sorted[0]?.runId ?? "x"}`,
      role: "assistant",
      createdAt: new Date(run.startedAt),
      content: parts,
      status: run.status === "running" ? { type: "running" } : { type: "complete", reason: "stop" },
    },
  ];
}
