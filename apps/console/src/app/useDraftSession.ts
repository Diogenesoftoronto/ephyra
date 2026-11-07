import { useCallback, useEffect, useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import type { ConsoleApi, DraftView } from "../api.ts";
import type { FormHost } from "../genui/registry.tsx";
import { newOp } from "../lib/hooks.ts";
import { formMessage } from "../lib/protocol.ts";
import { hasBlocking } from "../lib/warnings.ts";
import { useAsync } from "./useAsync.ts";

export type SendFailure = { error: unknown; text: string };

/**
 * Everything a draft screen does, over `ConsoleApi`. The application map is saved with `PUT /sketches` (the server renders
 * it to the document). Values a person changed in a Velum form go to Velum as a message, and the proposal Velum answers
 * with is applied; a proposal with parser errors is never applied. An unedited form applies its own proposal.
 */
export function useDraftSession(api: ConsoleApi, id: string) {
  const { state, reload, set } = useAsync(() => api.draft(id), `draft:${id}`);
  const draft = state.status === "ready" ? state.data : null;
  const [pending, setPending] = useState<string | undefined>();
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [live, setLive] = useState<AreaSketch[] | null>(null);

  const path = draft?.path;
  const isAutonomy = draft?.kind === "autonomy";
  useEffect(() => {
    if (!path || !isAutonomy) return;
    let alive = true;
    void api.doc(path).then(
      (d) => alive && setLive(d.sketches ?? null),
      () => alive && setLive(null),
    );
    return () => {
      alive = false;
    };
  }, [api, path, isAutonomy]);

  const send = useCallback(
    async (text: string): Promise<DraftView | null> => {
      setPending(text);
      setFailure(null);
      try {
        const next = await api.sendMessage(id, text, newOp());
        set(next);
        return next;
      } catch (error) {
        setFailure({ error, text });
        return null;
      } finally {
        setPending(undefined);
      }
    },
    [api, id, set],
  );

  const applyProposal = useCallback(
    async (messageId: string) => {
      set(await api.applyProposal(id, messageId, newOp()));
    },
    [api, id, set],
  );

  /** Ask Velum to turn structured values into a proposal, then apply it. Throws if there is no usable proposal. */
  const viaVelum = useCallback(
    async (text: string) => {
      setPending(text);
      setFailure(null);
      let next: DraftView;
      try {
        next = await api.sendMessage(id, text, newOp());
      } catch (error) {
        setPending(undefined);
        setFailure({ error, text });
        throw error;
      }
      setPending(undefined);
      set(next);
      const reply = next.messages.at(-1);
      if (!reply?.proposal)
        throw new Error("Velum did not return a proposal, so nothing was applied. See the conversation.");
      if (hasBlocking(reply.proposal.warnings))
        throw new Error("The result has parser errors, so it was not applied. See the conversation.");
      set(await api.applyProposal(id, reply.id, newOp()));
    },
    [api, id, set],
  );

  const saveMap = useCallback(
    async (sketches: readonly AreaSketch[]) => {
      if (!draft) return;
      set(await api.updateSketches(id, [...sketches], draft.baseDigest, newOp()));
    },
    [api, id, draft, set],
  );

  const formHost = useCallback(
    (messageId: string): FormHost => ({
      apply: async (values, edited) => {
        if (edited) return viaVelum(formMessage({ values }));
        if (!draft?.messages.find((m) => m.id === messageId)?.proposal)
          throw new Error("This form has no proposal to apply.");
        return applyProposal(messageId);
      },
      ask: (text) => {
        void send(text ?? "Explain this form and what each setting does.");
      },
      discard: () => undefined,
    }),
    [viaVelum, send, applyProposal, draft],
  );

  const saveContent = useCallback(
    async (content: string) => {
      if (!draft) return;
      set(await api.updateContent(id, content, draft.baseDigest, newOp()));
    },
    [api, id, draft, set],
  );
  const publish = useCallback(async () => {
    set(await api.publish(id, newOp()));
  }, [api, id, set]);
  const discard = useCallback(async () => {
    set(await api.discard(id, newOp()));
  }, [api, id, set]);

  return {
    state,
    reload,
    draft,
    pending,
    failure,
    send,
    applyProposal,
    saveMap,
    formHost,
    saveContent,
    publish,
    discard,
    liveMap: live,
    draftMap: draft?.sketches ?? null,
  };
}
