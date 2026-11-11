// Under the hood: the same quest, with nothing summarised away. Every event the journal holds, every effect the state
// machine asked for (with the key that makes it safe to retry), every attempt, question, agent run and receipt.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PERSONAS, proofDigest, type AgentRun, type AgentRunEvent, type Effect, type TrailEvent } from "@ephyra/core";
import { EngineBadge } from "../components/EngineBadge.tsx";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
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

function Effects({ hood }: { hood: HoodInput }) {
  const cause = new Map(hood.events.map((event) => [event.id, event]));
  if (!hood.effects.length) return <p className="lp-hood-empty">The state machine has not asked for anything yet.</p>;
  return (
    <ol className="lp-hood-list" data-hood-effects>
      {hood.effects.map(({ cause: id, effect }, i) => {
        const persona = effectPersona(effect);
        const from = cause.get(id);
        return (
          <li key={`${effect.key}-${i}`} data-type={effect.type}>
            <span className="lp-hood-who">{persona ? <PersonaAvatar persona={persona} size={24} /> : null}</span>
            <div>
              <p>{describeEffect(effect)}</p>
              <p className="lp-hood-meta">
                <span>because: {from ? narrate(from) : "an earlier event"}</span>
              </p>
              <p className="lp-hood-meta">
                <span>runs once, keyed by</span> <code data-idempotency-key title={effect.key}>{effect.key}</code>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
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

type Props = { hood: HoodInput; tab: HoodTab; onTab: (tab: HoodTab) => void; onClose: () => void; note?: string };

export function Inspector({ hood, tab, onTab, onClose, note }: Props) {
  const tabs = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
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
  return (
    <aside className="lp-hood" data-inspector aria-label={`Under the hood: ${hood.view.short}`}>
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
    </aside>
  );
}
