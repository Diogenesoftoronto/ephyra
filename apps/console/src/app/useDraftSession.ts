import { useCallback, useEffect, useState } from "react";
import type { AreaSketch, Draft } from "@ephyra/core";
import type { ConsoleApi } from "../api.ts";
import type { FormHost } from "../genui/registry.tsx";
import { newOp } from "../lib/hooks.ts";
import { formMessage, mapMessage } from "../lib/protocol.ts";
import { hasBlocking } from "../lib/warnings.ts";
import { useAsync } from "./useAsync.ts";

export type SendFailure = { error: unknown; text: string };

/**
 * Everything a draft screen does, over `ConsoleApi`. Structured edits (a form, the application map) go to Velum as a
 * message, and the proposal Velum answers with is applied; a proposal with parser errors is never applied.
 */
export function useDraftSession(api: ConsoleApi, id: string) {
  const { state, reload, set } = useAsync(() => api.draft(id), `draft:${id}`);
  const draft = state.status === "ready" ? state.data : null;
  const [pending, setPending] = useState<string | undefined>();
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [live, setLive] = useState<AreaSketch[] | null>(null);
  const [current, setCurrent] = useState<AreaSketch[] | null>(null);

  const stamp = draft?.updatedAt ?? "";
  const path = draft?.path;
  useEffect(() => {
    if (!draft || draft.kind !== "autonomy") return;
    let alive = true;
    void api.areaMap({ draftId: id }).then((m) => alive && setCurrent(m), () => alive && setCurrent(null));
    return () => { alive = false; };
  }, [api, id, stamp, draft?.kind]);
  useEffect(() => {
    if (!path || draft?.kind !== "autonomy") return;
    let alive = true;
    void api.areaMap({ path }).then((m) => alive && setLive(m), () => alive && setLive(null));
    return () => { alive = false; };
  }, [api, path, draft?.kind]);

  const send = useCallback(async (text: string): Promise<Draft | null> => {
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
  }, [api, id, set]);

  const applyProposal = useCallback(async (messageId: string) => { set(await api.applyProposal(id, messageId, newOp())); }, [api, id, set]);

  /** Ask Velum to turn structured values into a proposal, then apply it. Throws if there is no usable proposal. */
  const viaVelum = useCallback(async (text: string) => {
    setPending(text);
    setFailure(null);
    let next: Draft;
    try { next = await api.sendMessage(id, text, newOp()); } catch (error) { setPending(undefined); setFailure({ error, text }); throw error; }
    setPending(undefined);
    set(next);
    const reply = next.messages.at(-1);
    if (!reply?.proposal) throw new Error("Velum did not return a proposal, so nothing was applied.");
    if (hasBlocking(reply.proposal.warnings)) throw new Error("The result has parser errors, so it was not applied. Check the conversation.");
    set(await api.applyProposal(id, reply.id, newOp()));
  }, [api, id, set]);

  const saveMap = useCallback((sketches: readonly AreaSketch[]) => viaVelum(mapMessage(sketches)), [viaVelum]);

  const formHost = useCallback((_messageId: string): FormHost => ({
    apply: (values) => viaVelum(formMessage(values)),
    ask: (question) => { void send(question ?? "Explain this form and what each setting does."); },
    discard: () => undefined,
  }), [viaVelum, send]);

  const saveContent = useCallback(async (content: string) => {
    if (!draft) return;
    set(await api.updateContent(id, content, draft.baseDigest, newOp()));
  }, [api, id, draft, set]);
  const publish = useCallback(async () => { set(await api.publish(id, newOp())); }, [api, id, set]);
  const discard = useCallback(async () => { set(await api.discard(id, newOp())); }, [api, id, set]);

  return { state, reload, draft, pending, failure, send, applyProposal, saveMap, formHost, saveContent, publish, discard, liveMap: live, draftMap: current };
}
