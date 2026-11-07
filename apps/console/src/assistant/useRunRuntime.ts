import { useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { AgentRun, AgentRunEvent } from "@ephyra/core";
import { useMemo } from "react";
import { eventsToThread } from "./messages.ts";

/**
 * A read-only assistant-ui runtime over a run's events. There is no model behind it: the store holds what the server
 * recorded, and nothing the viewer types is sent anywhere.
 */
export function useRunRuntime(run: Pick<AgentRun, "status" | "startedAt">, events: readonly AgentRunEvent[]) {
  const messages = useMemo(() => eventsToThread(events, run), [events, run]);
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: run.status === "running",
    isDisabled: true,
    convertMessage: (m) => m,
    onNew: async () => {
      throw new Error("Run transcripts are read-only.");
    },
  });
}
