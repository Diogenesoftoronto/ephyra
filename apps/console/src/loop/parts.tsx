// The loop kit: small pieces that draw a quest from its view-model. Nothing here fetches or decides; every word and
// every position comes from `model.ts`, so the lab, the stories and the real console draw the same thing.
import { useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { PERSONAS, type AgentRun, type PersonaId, type TrailEvent } from "@ephyra/core";
import { EngineBadge } from "../components/EngineBadge.tsx";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import {
  ATTENTION_LABEL, LOOP_STAGES, lastOf, loopPoint, money, stage, type AttemptView, type Attention, type BudgetView,
  type FleetView, type JourneyStep, type QuestionView, type QuestView,
} from "./model.ts";
import "./loop.css";

const BASE = import.meta.env?.BASE_URL ?? "/app/";
export const loopAsset = (name: string): string => `${BASE}loop/${name}.webp`;
export const personaName = (id: PersonaId | null): string | null => PERSONAS.find((p) => p.id === id)?.name ?? null;
const vars = (values: Record<string, string | number>) => values as CSSProperties;
const clock = (iso: string): string => iso.slice(11, 16);

// ───────────────────────── Attention ─────────────────────────
// Colour never carries status alone: every state has its own glyph and its own word.

const GLYPH: Record<Attention, ReactNode> = {
  self: <circle cx="6" cy="6" r="3" fill="currentColor" stroke="none" />,
  recovering: <path d="M9.6 6a3.6 3.6 0 1 1-1.2-2.7M8.7 1.5v2.1H6.6" />,
  asking: <path d="M4.3 4.7a1.75 1.75 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2M6 9.7v.1" />,
  reverted: <path d="M3 4.5h4a2.5 2.5 0 0 1 0 5H4.6M3 4.5l2-2M3 4.5l2 2" />,
  needs_you: <path d="M2.4 8.8h7.2M3.6 8.8V6a2.4 2.4 0 0 1 4.8 0v2.8M5.2 10.5h1.6" />,
  held: <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none" />,
  set: <path d="M2.4 6.4l2.3 2.4 4.9-5.2" />,
  dropped: <path d="M3 3l6 6M9 3l-6 6" />,
};

export function AttentionMark({ attention, label = true, text }: { attention: Attention; label?: boolean; text?: string }) {
  return (
    <span className="lp-mark" data-attention={attention}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round">{GLYPH[attention]}</svg>
      <span className={label ? undefined : "sr-only"}>{text ?? ATTENTION_LABEL[attention]}</span>
    </span>
  );
}

// ───────────────────────── Specimen ─────────────────────────
// A quest is drawn as the jelly life stage it has reached. A stopped quest is a cyst; a rolled-back one has slumped.

export function spriteFor(quest: Pick<QuestView, "attention" | "stage">): string {
  if (quest.attention === "held" || quest.attention === "dropped") return "stuck";
  if (quest.attention === "reverted") return "rollback";
  return quest.stage.id;
}

export function Specimen({ quest, size = 56 }: { quest: Pick<QuestView, "attention" | "stage">; size?: number }) {
  const sprite = spriteFor(quest);
  return (
    <span className="lp-specimen" data-attention={quest.attention} style={vars({ "--size": `${size}px` })} aria-hidden="true">
      <img key={sprite} src={loopAsset(sprite)} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

// ───────────────────────── Loop meter ─────────────────────────
// Three ways to say "how far round the loop". `path` draws the loop's real shape: it sinks to git, then rises.

export type MeterVariant = "path" | "strip" | "ring";
const MW = 96;
const MH = 26;
const MP = 4;
const meterPoint = (progress: number): [number, number] => {
  const point = loopPoint(progress);
  return [MP + point.x * (MW - 2 * MP), MP + point.depth * (MH - 2 * MP)];
};
const trace = (to: number): string => {
  const n = Math.max(2, Math.ceil(to * 32));
  return Array.from({ length: n + 1 }, (_, i) => meterPoint((to * i) / n).map((v) => v.toFixed(1)).join(",")).join(" ");
};
const LOOP_TRACE = trace(1);

type Metered = Pick<QuestView, "stage" | "progress" | "attention" | "retreats">;

export function LoopMeter({ quest, variant = "path" }: { quest: Metered; variant?: MeterVariant }) {
  const sank = quest.retreats ? `, went back ${quest.retreats} ${quest.retreats === 1 ? "time" : "times"}` : "";
  const label = `Stage ${quest.stage.index + 1} of ${LOOP_STAGES.length}: ${quest.stage.label}${sank}`;
  if (variant === "strip") {
    return (
      <span className="lp-meter" data-variant="strip" data-attention={quest.attention} role="img" aria-label={label}>
        {LOOP_STAGES.map((s) => (
          <i key={s.id} data-on={s.index < quest.stage.index || undefined} data-now={s.index === quest.stage.index || undefined}
            data-gate={s.gate} />
        ))}
      </span>
    );
  }
  if (variant === "ring") {
    const r = 9;
    const around = 2 * Math.PI * r;
    return (
      <svg className="lp-meter" data-variant="ring" data-attention={quest.attention} viewBox="0 0 24 24" width="24" height="24"
        role="img" aria-label={label}>
        <circle className="lp-meter-rail" cx="12" cy="12" r={r} />
        <circle className="lp-meter-done" cx="12" cy="12" r={r} transform="rotate(-90 12 12)"
          strokeDasharray={`${(around * quest.progress).toFixed(1)} ${around.toFixed(1)}`} />
      </svg>
    );
  }
  const [x, y] = meterPoint(quest.progress);
  return (
    <svg className="lp-meter" data-variant="path" data-attention={quest.attention} viewBox={`0 0 ${MW} ${MH}`} width={MW}
      height={MH} role="img" aria-label={label}>
      <polyline className="lp-meter-rail" points={LOOP_TRACE} />
      <polyline className="lp-meter-done" points={trace(quest.progress)} />
      <circle className="lp-meter-dot" r="3.2" style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` }} />
    </svg>
  );
}

// ───────────────────────── Fleet ─────────────────────────

/** The one sentence that answers "what is my software doing by itself, and am I needed?". */
export function FleetSentence({ fleet, as: Tag = "h1" }: { fleet: FleetView; as?: "h1" | "h2" | "p" }) {
  const parts = fleet.sentence.match(/[^.]+\./g) ?? [fleet.sentence];
  const group = (part: string) => (/\bneeds? you\b/.test(part) ? "you" : /\bstopped\b/.test(part) ? "stopped"
    : /\bmoving by (itself|themselves)\b/.test(part) ? "self" : undefined);
  return (
    <Tag className="lp-fleet" data-loop-fleet>
      {parts.map((part, i) => {
        // The reasons in brackets are the second read, so they are set quieter than the count they explain.
        const aside = part.trim().match(/^(.*?)\s(\(.+\))\.$/);
        return (
          <span key={`${i}:${part}`} data-group={group(part)}>{aside ? <>{aside[1]} <i>{aside[2]}</i>.</> : part.trim()}{" "}</span>
        );
      })}
    </Tag>
  );
}

/** The same answer as three numbers. Faster to scan, but it loses the reasons the sentence carries. */
export function FleetTally({ fleet }: { fleet: FleetView }) {
  const cells: [string, number, string][] = [
    ["self", fleet.groups.self, "by themselves"], ["you", fleet.groups.you, "need you"], ["stopped", fleet.groups.stopped, "stopped"],
  ];
  return (
    <dl className="lp-tally" data-loop-tally>
      {cells.map(([group, n, label]) => (
        <div key={group} data-group={group} data-zero={n === 0 || undefined}><dt>{label}</dt><dd>{n}</dd></div>
      ))}
    </dl>
  );
}

// ───────────────────────── Quest row ─────────────────────────

export type RowVariant = "strip" | "sentence" | "card";
type RowProps = {
  quest: QuestView; variant?: RowVariant; meter?: MeterVariant; selected?: boolean; index?: number;
  onSelect?: (id: string) => void;
};

/** One quest on one line. The title is the only control; it stretches over the row, so the row has one target. */
export function QuestRow({ quest, variant = "strip", meter = "path", selected, index = 0, onSelect }: RowProps) {
  return (
    <li className="lp-row" data-variant={variant} data-quest={quest.short} data-attention={quest.attention}
      data-stage={quest.stage.id} data-retreats={quest.retreats} data-selected={selected || undefined} style={vars({ "--i": index })}>
      {variant === "card" && <Specimen quest={quest} size={48} />}
      <span className="lp-row-mark" data-rail><AttentionMark attention={quest.attention} /></span>
      <span className="lp-row-id" data-rail>{quest.short}</span>
      <button type="button" className="lp-row-title" data-rail aria-pressed={!!selected} onClick={() => onSelect?.(quest.id)}>
        {quest.title}
      </button>
      <span className="lp-row-meter" data-rail><LoopMeter quest={quest} variant={meter} /></span>
      <span className="lp-row-headline" data-rail>{quest.headline}</span>
      <span className="lp-row-who">
        {quest.persona && <PersonaAvatar persona={quest.persona} size={24} live={quest.group === "self"} />}
      </span>
    </li>
  );
}

// ───────────────────────── Attempts ─────────────────────────

export type LadderVariant = "rungs" | "pills" | "strike";

/** What the quest tried, in order, and what each try ran into. The reason an attempt ended is the next one's input. */
export function AttemptLadder({ ladder, variant = "rungs" }: { ladder: readonly AttemptView[]; variant?: LadderVariant }) {
  if (!ladder.length) return null;
  return (
    <ol className="lp-ladder" data-attempts data-variant={variant}>
      {ladder.map((attempt, i) => {
        const ran = ladder[i + 1]?.observations.at(-1) ?? null;
        const note = attempt.exhausted ? attempt.reason ?? "Out of attempts." : ran ?? attempt.means;
        return (
          <li key={attempt.key} data-strategy={attempt.strategy} data-current={attempt.current || undefined}
            data-spent={attempt.exhausted || undefined} data-past={ran !== null || undefined}>
            <span className="lp-ladder-n">{attempt.exhausted ? "×" : attempt.n}</span>
            <span className="lp-ladder-what">
              <b>{attempt.exhausted ? "Stopped" : attempt.label}</b>
              {variant === "rungs" && <span>{note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────── Question ─────────────────────────

/** A question Ephyra sent to a person: what it asked, who, why them, and what the checks said. */
export function QuestionCard({ question, variant = "letter" }: { question: QuestionView; variant?: "letter" | "compact" }) {
  return (
    <article className="lp-question" data-question={question.id.slice(0, 8)} data-status={question.status} data-variant={variant}>
      <p className="lp-eyebrow">
        <span>Asking {question.toYou ? "you" : question.to}</span>
        <span data-why-them>{question.because}</span>
      </p>
      <p className="lp-question-text">{question.question}</p>
      {variant === "letter" && (
        <dl>
          <div><dt>Why it matters</dt><dd>{question.reason}</dd></div>
          <div><dt>A good answer</dt><dd>{question.acceptance}</dd></div>
        </dl>
      )}
      {question.answer && (
        <blockquote data-ok={question.answer.accepted}>
          <p>{question.answer.text}</p>
          <footer>{question.answer.by} · {question.answer.accepted ? "accepted as evidence" : "not accepted as evidence"}</footer>
        </blockquote>
      )}
      <ul className="lp-checks">
        {question.checks.map((check, i) => (
          <li key={i} data-check={check.phase} data-ok={check.accepted}>
            <AttentionMark attention={check.accepted ? "set" : "dropped"} label={false} />
            <span>{check.phase === "question" ? "Question" : "Answer"} checked by <code>{check.model}</code>: </span>
            <b>{check.accepted ? "accepted" : "rejected"}</b>
          </li>
        ))}
        <li data-delivery>{question.delivery}</li>
      </ul>
    </article>
  );
}

// ───────────────────────── Journey ─────────────────────────

/**
 * A quest's path as a dive profile: each move is one step to the right, depth is how far it is from production.
 * A failed proof or a rollback shows as a second descent, which is what a retreat is.
 */
export function DiveProfile({ steps, width = 320, height = 96 }: { steps: readonly JourneyStep[]; width?: number; height?: number }) {
  const moves = steps.filter((step, i) => i === 0 || step.kind !== "stay");
  if (moves.length < 2) return null;
  const pad = 18;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (moves.length - 1);
  const y = (step: JourneyStep) => pad + stage(step.stage).depth * (height - 2 * pad);
  const retreats = moves.filter((step) => step.kind === "retreat").length;
  const lap = moves.at(-1)?.lap ?? 1;
  const summary = `${moves.length} moves through the loop`
    + (retreats ? `, went back to an earlier stage ${retreats} ${retreats === 1 ? "time" : "times"}` : ", never went back");
  return (
    <figure className="lp-dive" data-path data-retreats={retreats}>
      <div className="lp-dive-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} preserveAspectRatio="none">
          <line className="lp-dive-level" x1={0} x2={width} y1={pad} y2={pad} />
          <line className="lp-dive-level" x1={0} x2={width} y1={height - pad} y2={height - pad} />
          {moves.slice(1).map((step, i) => (
            <line key={i} className="lp-dive-leg" data-kind={step.kind} x1={x(i)} y1={y(moves[i]!)} x2={x(i + 1)} y2={y(step)} />
          ))}
          {/* Zero-length round-capped strokes: they stay round however far the plot is stretched. */}
          {moves.map((step, i) => (
            <path key={i} className="lp-dive-stop" data-kind={step.kind} data-last={i === moves.length - 1 || undefined}
              d={`M${x(i)} ${y(step)}h0.01`}>
              <title>{`${clock(step.at)} ${step.text}`}</title>
            </path>
          ))}
        </svg>
        <span data-level="surface" aria-hidden="true">production</span>
        <span data-level="seabed" aria-hidden="true">git</span>
      </div>
      <figcaption>
        {moves.length} moves{retreats ? `, went back ${retreats === 1 ? "once" : `${retreats} times`}` : ", never went back"}
        {lap > 1 ? `, lap ${lap}` : ""}
      </figcaption>
    </figure>
  );
}

/** The same path as sentences, for people who read rather than look, and for screen readers. */
export function JourneyList({ steps, limit = 8 }: { steps: readonly JourneyStep[]; limit?: number }) {
  const notable = steps.filter((step) => step.kind !== "stay" && step.type !== "implied").slice(-limit);
  return (
    <ol className="lp-journey">
      {notable.map((step, i) => (
        <li key={step.event ?? i} data-kind={step.kind} data-stage={step.stage}>
          <time dateTime={step.at}>{clock(step.at)}</time>
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

// ───────────────────────── Budget ─────────────────────────

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

export function BudgetBars({ budget }: { budget: BudgetView }) {
  const bars: [string, string, number][] = [
    ["Tokens", `${compact(budget.tokens.used)} of ${compact(budget.tokens.max)}`, budget.tokens.ratio],
    ["Spend", `${money(budget.spend.used)} of ${money(budget.spend.max)}`, budget.spend.ratio ?? 0],
  ];
  return (
    <dl className="lp-budget" data-blocked={budget.blocker ? true : undefined}>
      {bars.map(([label, value, ratio]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd><span>{value}</span><i style={vars({ "--ratio": ratio.toFixed(3) })} /></dd>
        </div>
      ))}
      {budget.blocker && <p>{budget.blocker}</p>}
    </dl>
  );
}

// ───────────────────────── The one thing a person can do ─────────────────────────

/** What a person is approving, read from the last proof the quest recorded. Null when nothing was proven. */
export function proofLine(events: readonly TrailEvent[]): string | null {
  const proof = lastOf(events, (event) => event.type === "proof_completed");
  if (proof?.type !== "proof_completed") return null;
  const { bundle } = proof.data;
  const kinds = bundle.items.map((item) => item.kind.replace(/_/g, " ")).join(", ");
  return bundle.passed ? `Proof passed: ${kinds}.` : `Proof failed. Missing: ${bundle.missing.join(", ")}.`;
}

/** A handler may answer with whether the write went through. Saying nothing counts as done. */
type Outcome = void | boolean | Promise<void | boolean>;
type NeedsYouProps = {
  quest: QuestView; proof?: string | null; more?: number;
  /** A write is in flight: the controls wait for it. */
  busy?: boolean;
  onAct: (quest: QuestView) => void;
  onRevise?: (quest: QuestView, note: string) => Outcome;
  onDrop?: (quest: QuestView) => Outcome;
};

/** The docked strip: the single primary action of the view, with its two ways out kept quiet beside it. */
export function NeedsYou({ quest, proof, more = 0, busy = false, onAct, onRevise, onDrop }: NeedsYouProps) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [dropping, setDropping] = useState(false);
  if (!quest.action) return null;
  // The note is someone's careful correction. It leaves the form only once the server has taken it.
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim() || busy) return;
    if (await onRevise?.(quest, note.trim()) === false) return;
    setNoting(false);
    setNote("");
  };
  const confirmDrop = async () => {
    if (busy) return;
    if (await onDrop?.(quest) !== false) setDropping(false);
  };
  return (
    <section className="lp-needs" data-needs-you={quest.short} aria-label="Needs you">
      <Specimen quest={quest} size={48} />
      <div className="lp-needs-what">
        <p className="lp-eyebrow">
          <AttentionMark attention="needs_you" />
          <span>{quest.short}</span>
          <span>{quest.risk} risk · {quest.area}</span>
          {more > 0 && <span>and {more} more</span>}
        </p>
        <p className="lp-needs-title">{quest.title}</p>
        <p className="lp-needs-why">{[quest.headline, quest.detail, proof].filter(Boolean).join(". ").replace(/\.\./g, ".")}</p>
      </div>
      {noting ? (
        <form className="lp-needs-note" onSubmit={send}>
          <label htmlFor={`note-${quest.short}`}>What should change?</label>
          <input id={`note-${quest.short}`} value={note} onChange={(event) => setNote(event.target.value)} autoFocus
            maxLength={4000} placeholder="It becomes the next attempt's first observation" />
          <button type="submit" className="lp-primary" data-primary disabled={busy || !note.trim()}>Send back</button>
          <button type="button" className="lp-quiet" disabled={busy} onClick={() => setNoting(false)}>Cancel</button>
        </form>
      ) : (
        <div className="lp-needs-actions">
          <button type="button" className="lp-primary" data-primary disabled={busy} onClick={() => onAct(quest)}>
            {quest.action.label}<kbd aria-hidden="true">a</kbd>
          </button>
          {quest.action.kind === "decide" && onRevise && !dropping && (
            <button type="button" className="lp-quiet" disabled={busy} onClick={() => setNoting(true)}>Send back</button>
          )}
          {/* Dropping ends a quest, so the button changes into its own confirmation and says what it will do. */}
          {quest.action.kind === "decide" && onDrop && (dropping ? (
            <>
              <button type="button" className="lp-quiet" data-danger data-confirm-drop disabled={busy} autoFocus onClick={confirmDrop}>
                Confirm drop
              </button>
              <button type="button" className="lp-quiet" disabled={busy} onClick={() => setDropping(false)}>Keep it</button>
              <span className="lp-needs-warn" role="status">Nothing lands and the quest ends.</span>
            </>
          ) : (
            <button type="button" className="lp-quiet" disabled={busy} onClick={() => setDropping(true)}>Drop</button>
          ))}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── Quest detail ─────────────────────────

type DetailProps = {
  quest: QuestView; steps: readonly JourneyStep[]; now?: string | null; run?: AgentRun | null;
  onInspect?: () => void;
  /** Said in place of the path while the quest's journal has not been read yet. */
  pending?: string | null;
  /** What a person can do about this quest. It follows the question, so the question is read before it is answered. */
  children?: ReactNode;
};

/** Everything worth knowing about one quest before opening the hood: where, why, what it tried, who it asked. */
export function QuestDetail({ quest, steps, now, run, onInspect, pending, children }: DetailProps) {
  const who = personaName(quest.persona);
  // An asking quest's second line is the question itself, which the card below already says in full.
  const why = quest.detail && quest.detail !== quest.question?.question ? quest.detail : null;
  return (
    <article className="lp-detail" data-detail={quest.short} data-attention={quest.attention} data-stage={quest.stage.id}>
      <header>
        <Specimen quest={quest} size={72} />
        <div>
          <p className="lp-eyebrow"><span>{quest.short}</span><span>{quest.area} · {quest.risk} risk · rev {quest.rev}</span></p>
          <h2>{quest.title}</h2>
        </div>
        {onInspect && (
          <button type="button" className="lp-quiet" data-open-hood onClick={onInspect}>Under the hood<kbd aria-hidden="true">i</kbd></button>
        )}
      </header>
      <div className="lp-detail-state">
        <p className="lp-detail-headline"><AttentionMark attention={quest.attention} label={false} />{quest.headline}</p>
        {why && <p className="lp-detail-why">{why}</p>}
      </div>
      {now && quest.persona && (
        <p className="lp-now" data-now>
          <PersonaAvatar persona={quest.persona} size={24} live />
          <span><b>{who}</b> <code>{now}</code></span>
          {run && <EngineBadge engine={run.engine} executor={run.executor} />}
        </p>
      )}
      {quest.ladder.length > 1 && (
        <section>
          <h3>What it has tried</h3>
          <AttemptLadder ladder={quest.ladder} />
        </section>
      )}
      {quest.question && <QuestionCard question={quest.question} />}
      {children}
      <section>
        <h3>Path through the loop</h3>
        {pending ? <p className="lp-detail-pending" data-pending>{pending}</p> : (
          <>
            <DiveProfile steps={steps} />
            <JourneyList steps={steps} limit={4} />
          </>
        )}
      </section>
      <BudgetBars budget={quest.budget} />
    </article>
  );
}

// ───────────────────────── Transport ─────────────────────────

export type TransportBeacon = { tick: number; kind: string; text: string; short: string };
type TransportProps = {
  tick: number; last: number; label: string; playing: boolean; beacons: readonly TransportBeacon[];
  onTick: (tick: number) => void; onPlay: (playing: boolean) => void;
};

/** A flight recorder: drag through the hour and every quest replays. Marks are the moments worth stopping on. */
export function Transport({ tick, last, label, playing, beacons, onTick, onPlay }: TransportProps) {
  return (
    <div className="lp-transport" data-transport role="group" aria-label="Replay">
      <button type="button" className="lp-quiet" aria-pressed={playing} onClick={() => onPlay(!playing)}>
        {playing ? "Pause" : "Play"}
      </button>
      <output className="lp-transport-time" aria-live="off">{label}</output>
      <div className="lp-transport-track">
        <div className="lp-transport-marks" aria-hidden="true">
          {beacons.map((beacon, i) => (
            <i key={i} data-kind={beacon.kind} data-past={beacon.tick <= tick || undefined}
              style={vars({ "--at": (beacon.tick / last).toFixed(4) })} title={`${beacon.short}: ${beacon.text}`} />
          ))}
        </div>
        <input type="range" min={0} max={last} step={1} value={tick} aria-label="Time in the recorded hour"
          aria-valuetext={label} onChange={(event) => onTick(Number(event.target.value))} />
      </div>
    </div>
  );
}
