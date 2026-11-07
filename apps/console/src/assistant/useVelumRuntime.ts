import { useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { DraftMessage } from "@ephyra/core";
import { useMemo } from "react";
import { draftToThread } from "./messages.ts";

/**
 * assistant-ui runtime for the Velum chat. It is an ExternalStoreRuntime over the draft's messages: the thread shows what
 * the server stored, plus the human message being sent. `onSend` goes to the Ephyra API; the browser calls no model.
 */
export function useVelumRuntime({ messages, pending, busy, disabled, onSend }: {
  messages: readonly DraftMessage[]; pending?: string; busy: boolean; disabled?: boolean; onSend: (text: string) => Promise<void>;
}) {
  const thread = useMemo(() => draftToThread(messages, pending), [messages, pending]);
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages: thread, isRunning: busy, isDisabled: disabled, convertMessage: (m) => m,
    onNew: async (message) => {
      const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
      if (text) await onSend(text);
    },
  });
}
