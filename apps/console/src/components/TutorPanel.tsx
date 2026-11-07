import { useEffect, useRef, useState } from "react";
import { trailTutorBinding, type Trail, type TrailEvent, type TutorReply } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { VoiceRequestError } from "../api.ts";
import { Badge, Button, Card, Field, Notice } from "../kit.ts";
import { DictateButton, GuidedVoiceButton, ReadAloudButton } from "../voice/Voice.tsx";
import { formatMicrousd } from "../lib/format.ts";
import { newOp } from "../lib/hooks.ts";
import "./TutorPanel.css";

type Turn = { question: string; reply: TutorReply };
export function TutorPanel({
  trail,
  events,
  canSpend = true,
}: {
  trail: Trail;
  events: TrailEvent[];
  canSpend?: boolean;
}) {
  const bound = trailTutorBinding(trail, events);
  return (
    <TutorConversation key={JSON.stringify([trail.id, bound])} trail={trail} events={events} canSpend={canSpend} />
  );
}
function TutorConversation({ trail, events, canSpend }: { trail: Trail; events: TrailEvent[]; canSpend: boolean }) {
  const api = useApi();
  const capabilities = useAsync(() => api.tutorCapabilities(), "tutor-capabilities");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const history = useRef<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; blocked: boolean } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const blocked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  const cap = capabilities.state.status === "ready" ? capabilities.state.data : null;
  const bound = trailTutorBinding(trail, events);
  const label = `${trail.short} · revision ${bound.rev} · &Tutor`;
  const off = !canSpend || !cap?.provider || busy || failure?.blocked || turns.at(-1)?.reply.stale;
  const ask = async (text: string, signal?: AbortSignal): Promise<TutorReply> => {
    if (pending.current || blocked.current || !canSpend || !cap?.provider)
      throw new Error("&Tutor is unavailable for this conversation.");
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure(null);
    try {
      const reply = await api.explainTrail(
        {
          trailId: trail.id,
          bound,
          question: text,
          history: history.current.slice(-2).flatMap((t) => [
            { role: "user" as const, text: t.question },
            { role: "assistant" as const, text: t.reply.text },
          ]),
        },
        newOp(),
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      );
      if (!mounted.current || controller.signal.aborted || signal?.aborted)
        throw new VoiceRequestError(
          "reconciliation_required",
          "The explanation finished after this conversation closed. Check Usage before asking again.",
        );
      history.current = [...history.current, { question: text, reply }];
      setTurns(history.current);
      setQuestion("");
      if (reply.stale) blocked.current = true;
      return reply;
    } catch (e) {
      const stop = e instanceof VoiceRequestError && ["reconciliation_required", "stale_context"].includes(e.code);
      blocked.current = stop;
      if (mounted.current)
        setFailure({ message: e instanceof Error ? e.message : "&Tutor could not answer.", blocked: stop });
      throw e;
    } finally {
      pending.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const send = (text: string) => {
    void ask(text).catch(() => {});
  };
  return (
    <Card tone="quiet" title="Understand this trail" meta={<Badge>&amp;Tutor</Badge>}>
      <div className="tutor-panel stack">
        <p>Work through the reproduction, patch and proof, and what an approval would allow.</p>
        {cap?.provider && (
          <p className="muted">
            {cap.model} via {cap.provider === "notorganic" ? "Not Organic" : "Humans&"} · revision {bound.rev}
          </p>
        )}
        {capabilities.state.status === "loading" && <p role="status">Checking Tutor availability…</p>}
        {capabilities.state.status === "error" && (
          <p role="alert">
            Tutor availability could not be checked.{" "}
            <Button size="sm" onClick={capabilities.reload}>
              Check again
            </Button>
          </p>
        )}
        {cap && !cap.provider && (
          <Notice
            tone="warn"
            title="Tutor is not connected"
            body="An operator can connect &Tutor through Not Organic or a Humans& API key. The recorded evidence remains available below."
          />
        )}
        {!canSpend && <p className="muted">Only approvers can spend the deployment's model budget.</p>}
        <div className="tutor-turns" aria-label="Tutor explanations" aria-live="polite">
          {turns.map((turn, i) => (
            <article key={i} className="tutor-turn">
              <p className="tutor-question">{turn.question}</p>
              <p className="tutor-answer">{turn.reply.text}</p>
              {turn.reply.stale && (
                <Notice
                  tone="warn"
                  title="This explanation is out of date"
                  body="The trail changed while Tutor was answering. Reload and read the current evidence before deciding."
                />
              )}
              <ReadAloudButton text={turn.reply.text} label="Tutor's explanation, read by Velum" />
              <details>
                <summary>Records Tutor received · revision {turn.reply.bound.rev}</summary>
                {turn.reply.sources.map((source, j) => (
                  <div key={j}>
                    <strong>{source.label}</strong>
                    <pre>{source.excerpt}</pre>
                  </div>
                ))}
              </details>
              <p className="muted tutor-receipt">
                {turn.reply.receipt.engine ?? "Model identity unavailable"} ·{" "}
                {formatMicrousd(turn.reply.receipt.costMicrousd)} · <a href="#/usage">Usage</a>
              </p>
            </article>
          ))}
        </div>
        {failure && (
          <Notice
            tone="warn"
            title="Tutor paused"
            body={
              <>
                {failure.message} {failure.blocked && <a href="#/usage">Check Usage</a>}
              </>
            }
          />
        )}
        {!turns.length && (
          <div className="tutor-actions">
            <Button
              disabled={Boolean(off)}
              loading={busy}
              onClick={() =>
                send(
                  "Explain this trail, what is still unverified, and what approving the current checkpoint would allow.",
                )
              }
            >
              Explain this trail
            </Button>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!off && question.trim()) send(question.trim());
          }}
        >
          <Field label="Ask Tutor">
            <textarea
              rows={2}
              maxLength={1000}
              value={question}
              disabled={Boolean(off)}
              placeholder="What does this proof actually establish?"
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
          <div className="tutor-actions">
            <Button type="submit" disabled={Boolean(off) || !question.trim()} loading={busy}>
              Ask Tutor
            </Button>
            <DictateButton
              label="Ask Tutor"
              disabled={Boolean(off)}
              onText={(text) => setQuestion((old) => `${old}${old ? " " : ""}${text}`.slice(0, 1000))}
            />
            <GuidedVoiceButton
              name="&Tutor"
              label={label}
              disabled={Boolean(off)}
              answer={async (text, signal) => {
                const result = await ask(text, signal);
                return {
                  text: result.stale
                    ? `This explanation is out of date. Reload the trail before deciding. ${result.text}`
                    : result.text,
                  receipt: result.receipt,
                };
              }}
            />
          </div>
        </form>
        <p className="muted tutor-boundary">
          Explanations help you review. Decisions happen at the checkpoint controls. The conversation view clears when
          you leave. Usage is recorded.
        </p>
      </div>
    </Card>
  );
}
