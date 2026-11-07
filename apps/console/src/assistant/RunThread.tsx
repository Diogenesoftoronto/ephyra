import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type { AgentRun, AgentRunEvent } from "@ephyra/core";
import { Empty } from "../kit.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import { PolicyLine, PortalLine, ReasoningGroup, ReasoningText, StatusLine } from "./RunParts.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { useRunRuntime } from "./useRunRuntime.ts";
import "./assistant.css";

function RunMessage() {
  return (
    <MessagePrimitive.Root className="thread-bubble">
      <MessagePrimitive.Parts components={{
        Text: MarkdownText, Reasoning: ReasoningText, ReasoningGroup,
        tools: { Fallback: ToolCard },
        data: { by_name: { status: StatusLine, portal: PortalLine, policy: PolicyLine } },
      }} />
    </MessagePrimitive.Root>
  );
}

/** A run's event stream as a read-only assistant-ui thread. New events append and the view follows them while it is at the bottom. */
export function RunThread({ run, events }: { run: Pick<AgentRun, "status" | "startedAt">; events: readonly AgentRunEvent[] }) {
  const runtime = useRunRuntime(run, events);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport" aria-label="Run transcript" tabIndex={0}>
          <ThreadPrimitive.Empty><Empty title="Nothing recorded yet" body="Events appear here as the agent works." /></ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ Message: RunMessage }} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
