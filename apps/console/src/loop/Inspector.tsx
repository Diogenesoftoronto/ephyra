// Under the hood: the same quest, with nothing summarised away. Every event the journal holds, every effect the state
// machine asked for (with the key that makes it safe to retry), every attempt, question, agent run and receipt.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PERSONAS, proofDigest, type AgentRun, type AgentRunEvent, type Effect, type TrailEvent } from "@ephyra/core";
import { EngineBadge } from "../components/EngineBadge.tsx";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { playFeedback } from "../lib/feedback.ts";
import { describeEffect, effectPersona, narrate, type QuestView } from "./model.ts";
import { AttemptLadder, QuestionCard } from "./parts.tsx";

export type HoodInput = {
  view: QuestView;
  events: readonly TrailEvent[];
  effects: readonly { cause: string; effect: Effect }[];
  runs: readonly AgentRun[];
  runEvents: (runId: string) => readonly AgentRunEvent[];
};

export const HOOD_TABS = ["events", "effects", "attempts", "questions", "runs", "receipts"] as const;
export type HoodTab = (typeof HOOD_TABS)[number];
const TAB_LABEL: Record<HoodTab, string> = {
  events: "Events", effects: "Effects", attempts: "Attempts", questions: "Questions", runs: "Runs", receipts: "Receipts",
};

const clock = (iso: string): string => iso.slice(11, 19);
const who = (event: TrailEvent): string => {
  if (event.actor.kind === "agent") return PERSONAS.find((p) => p.id === event.actor.id)?.name ?? event.actor.id;
  if (event.actor.kind === "human") return event.actor.id;
  return event.actor.kind === "policy" ? "Policy" : `Ephyra ${event.actor.id.split(":")[0]}`;
};

function Events({ events }: { events: readonly TrailEvent[] }) {
  return (
    <ol className="lp-hood-list" data-hood-events>
      {events.map((event) => (
        <li key={event.id} data-type={event.type}>
          <time dateTime={event.at}>{clock(event.at)}</time>
          <div>
            <p>{narrate(event)}</p>
            <details>
              <summary><span>{who(event)}</span><code>{event.type}</code></summary>
              <pre>{JSON.stringify(event.data, null, 2)}</pre>
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** An operation key is for comparing and copying, so it is shown whole and can be copied without selecting it. */
function OperationKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      playFeedback("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* No clipboard here. The key is on screen in full and can be selected. */ }
  };
  return (
    <p className="lp-hood-key">
      <span>operation key</span>
      <code data-idempotency-key>{value}</code>
      <button type="button" className="lp-quiet" onClick={copy} aria-label={`Copy operation key ${value}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </p>
  );
}

function Effects({ hood }: { hood: HoodInput }) {
  const cause = new Map(hood.events.map((event) => [event.id, event]));
  if (!hood.effects.length) return <p className="lp-hood-empty">The state machine has not asked for anything yet.</p>;
  return (
    <>
      <p className="lp-hood-meta">
        What the engine asked for, oldest first. This is a record of each request, not of its delivery.
      </p>
      <ol className="lp-hood-list" data-hood-effects>
        {hood.effects.map(({ cause: id, effect }, i) => {
          const persona = effectPersona(effect);
          const from = cause.get(id);
          return (
            <li key={`${effect.key}-${i}`} data-type={effect.type}>
              <span className="lp-hood-who">{persona ? <PersonaAvatar persona={persona} size={24} /> : null}</span>
              <div>
                <p>{describeEffect(effect)}</p>
                <p className="lp-hood-meta"><span>because: {from ? narrate(from) : "an earlier event"}</span></p>
                <OperationKey value={effect.key} />
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function Attempts({ view }: { view: QuestView }) {
  if (!view.attempts.length) return <p className="lp-hood-empty">No agent has started on this quest yet.</p>;
  const steps = [...new Set(view.attempts.map((attempt) => attempt.step))];
  return (
    <div className="lp-hood-groups">
      {steps.map((step) => {
        const mine = view.attempts.filter((attempt) => attempt.step === step);
        return (
          <section key={step}>
            <h4>{step} <span>{mine.length} {mine.length === 1 ? "attempt" : "attempts"}</span></h4>
            <AttemptLadder ladder={mine} />
          </section>
        );
      })}
      <p className="lp-hood-meta">
        Proof has failed {view.proofAttempts.used} of {view.proofAttempts.max} allowed times on this revision.
      </p>
    </div>
  );
}

function Runs({ hood }: { hood: HoodInput }) {
  const [open, setOpen] = useState<string | null>(null);
  const runs = [...hood.runs].reverse();
  const shown = runs.find((run) => run.id === open) ?? runs[0];
  if (!shown) return <p className="lp-hood-empty">No agent has run on this quest yet.</p>;
  const lines = hood.runEvents(shown.id);
  return (
    <div className="lp-hood-runs">
      <ul>
        {runs.map((run) => (
          <li key={run.id} data-status={run.status}>
            <button type="button" aria-pressed={run.id === shown.id} onClick={() => setOpen(run.id)}>
              {run.persona && <PersonaAvatar persona={run.persona} size={24} live={run.status === "running"} />}
              <span>{run.step}</span>
              <span className="lp-hood-meta">{run.status} · {clock(run.startedAt).slice(0, 5)}</span>
            </button>
            <EngineBadge engine={run.engine} executor={run.executor} />
          </li>
        ))}
      </ul>
      <ol className="lp-transcript" data-hood-transcript aria-label={`What the ${shown.step} agent did`}>
        {lines.length === 0 && <li className="lp-hood-empty">Nothing streamed yet.</li>}
        {lines.map((line) => (
          <li key={line.seq} data-type={line.type}>
            <time dateTime={line.at}>{clock(line.at)}</time>
            {line.tool ? <code>{line.tool.name} {line.tool.args}</code>
              : line.policy ? <span>Policy {line.policy.decision}: {line.policy.reason} <code>{line.policy.rule}</code></span>
              : <span>{line.text}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Receipts({ events }: { events: readonly TrailEvent[] }) {
  const rows = events.flatMap((event) => {
    if (event.type === "proof_completed") {
      const { bundle } = event.data;
      return [{
        id: event.id, at: event.at, kind: "Proof", ok: bundle.passed,
        text: bundle.passed ? `Passed at revision ${bundle.rev}` : `Failed at revision ${bundle.rev}: missing ${bundle.missing.join(", ")}`,
        facts: [["digest", proofDigest(bundle)], ["head", bundle.head], ["runner", bundle.env.runner],
          ["items", bundle.items.map((item) => item.kind).join(", ") || "none"]],
      }];
    }
    if (event.type === "landing_completed") {
      const { receipt } = event.data;
      return [{
        id: event.id, at: event.at, kind: "Landing", ok: true, text: `Landed by ${receipt.mode} on ${receipt.target}`,
        facts: [["new", receipt.newOid], ["old", receipt.oldOid ?? "none"], ...(receipt.proofDigest ? [["proof", receipt.proofDigest]] : [])],
      }];
    }
    if (event.type === "checkpoint_decided") {
      const { decision, checkpoint } = event.data;
      return [{
        id: event.id, at: event.at, kind: `Checkpoint ${checkpoint}`, ok: decision.verdict === "approve",
        text: `${decision.by === "human" ? decision.who ?? "A person" : "Policy"}: ${decision.verdict}`,
        facts: decision.note ? [["note", decision.note]] : [],
      }];
    }
    return [];
  });
  if (!rows.length) return <p className="lp-hood-empty">Nothing has been proven, decided or landed yet.</p>;
  return (
    <ol className="lp-hood-list" data-hood-receipts>
      {rows.map((row) => (
        <li key={row.id} data-ok={row.ok}>
          <time dateTime={row.at}>{clock(row.at)}</time>
          <div>
            <p><b>{row.kind}</b> {row.text}</p>
            {row.facts.length > 0 && (
              <dl className="lp-hood-facts">
                {row.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
              </dl>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

type Props = {
  hood: HoodInput; tab: HoodTab; onTab: (tab: HoodTab) => void; onClose: () => void; note?: string;
  /**
   * `modal` (the default) covers the page: focus stays inside, the page behind is inert and its keys do nothing.
   * `column` sits beside the board where there is room for both, and the board stays usable.
   */
  mode?: "modal" | "column";
};

export function Inspector({ hood, tab, onTab, onClose, note, mode = "modal" }: Props) {
  const tabs = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // Open as a modal before the first paint, so the panel is never on screen without holding focus.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    heading.current?.focus();
  }, []);
  const counts: Record<HoodTab, number> = {
    events: hood.events.length, effects: hood.effects.length, attempts: hood.view.attempts.length,
    questions: hood.view.questions.length, runs: hood.runs.length,
    receipts: hood.events.filter((e) => e.type === "proof_completed" || e.type === "landing_completed" || e.type === "checkpoint_decided").length,
  };
  const move = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = HOOD_TABS[(HOOD_TABS.indexOf(tab) + step + HOOD_TABS.length) % HOOD_TABS.length]!;
    onTab(next);
    tabs.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };
  const label = `Under the hood: ${hood.view.short}`;
  const body: ReactNode = (
    <>
      <header>
        <div>
          <p className="lp-eyebrow"><span>Under the hood</span><span>{hood.view.short}</span></p>
          <h2 ref={heading} tabIndex={-1}>{hood.view.title}</h2>
        </div>
        <button type="button" className="lp-quiet" onClick={onClose} aria-label="Close under the hood">Close<kbd aria-hidden="true">i</kbd></button>
      </header>
      {note && <p className="lp-hood-note">{note}</p>}
      <div className="lp-hood-tabs" role="tablist" aria-label="What to inspect" ref={tabs} onKeyDown={move}>
        {HOOD_TABS.map((id) => (
          <button key={id} type="button" role="tab" data-tab={id} id={`hood-tab-${id}`} aria-selected={id === tab}
            aria-controls="hood-panel" tabIndex={id === tab ? 0 : -1} onClick={() => onTab(id)}>
            {TAB_LABEL[id]}<span>{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="lp-hood-panel" role="tabpanel" id="hood-panel" aria-labelledby={`hood-tab-${tab}`} tabIndex={0} data-panel={tab}>
        {tab === "events" && <Events events={hood.events} />}
        {tab === "effects" && <Effects hood={hood} />}
        {tab === "attempts" && <Attempts view={hood.view} />}
        {tab === "questions" && (hood.view.questions.length
          ? hood.view.questions.map((question) => <QuestionCard key={question.id} question={question} />)
          : <p className="lp-hood-empty">This quest has not needed to ask anyone.</p>)}
        {tab === "runs" && <Runs hood={hood} />}
        {tab === "receipts" && <Receipts events={hood.events} />}
      </div>
    </>
  );
  if (mode === "column") return <aside className="lp-hood" data-inspector data-mode="column" aria-label={label}>{body}</aside>;
  // The page's own keys are off while this is open, so the one that opened it is honoured here: `i` closes it again.
  const keys = (event: KeyboardEvent) => {
    // Escape is the dialog's own: it arrives as `cancel`. Every other key stops here, so the page behind does not act on it.
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.key !== "i" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
    event.preventDefault();
    onClose();
  };
  return (
    <dialog ref={dialog} className="lp-hood" data-inspector data-mode="modal" aria-label={label} onKeyDown={keys}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
      {body}
    </dialog>
  );
}
