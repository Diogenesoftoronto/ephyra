// Seven ways to lay out the same hour. Each one gets the same world and the same kit, so what differs between them
// is only arrangement: what a person sees first, what sits beside what, and how much has to be read.
import type { CSSProperties, ReactNode } from "react";
import { PERSONAS } from "@ephyra/core";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { LoopScene, QuestGroups, slots } from "../loop/board.tsx";
import { ATTENTION_LABEL, LOOP_STAGES, byAttention, lastOf, narrate, type JourneyStep, type QuestView } from "../loop/model.ts";
import {
  AttentionMark, FleetSentence, NeedsYou, QuestDetail, QuestRow, Specimen, personaName, proofLine, type MeterVariant, type RowVariant,
} from "../loop/parts.tsx";
import type { QuestWorld, World } from "../loop/scenario.ts";

export type LayoutProps = {
  world: World;
  selected: QuestWorld | null;
  /** The quest whose action is this view's one primary action, and how many more are waiting behind it. */
  needs: QuestWorld | null;
  moreNeeds: number;
  steps: JourneyStep[];
  now: string | null;
  narrow: boolean;
  row: RowVariant | null;
  meter: MeterVariant;
  select: (id: string) => void;
  act: (quest: QuestView) => void;
  revise: (quest: QuestView, note: string) => void;
  drop: (quest: QuestView) => void;
  inspect: () => void;
};

const vars = (values: Record<string, string | number>) => values as CSSProperties;
const clock = (iso: string): string => iso.slice(11, 16);

function Needs(p: LayoutProps) {
  if (!p.needs) return null;
  return (
    <NeedsYou quest={p.needs.view} proof={proofLine(p.needs.events)} more={p.moreNeeds} onAct={p.act} onRevise={p.revise}
      onDrop={p.drop} />
  );
}

function Detail(p: LayoutProps) {
  if (!p.selected) return <p className="lab-empty">Production is quiet. Nothing to look at.</p>;
  const run = lastOf(p.selected.runs, (entry) => entry.status === "running") ?? null;
  return <QuestDetail quest={p.selected.view} steps={p.steps} now={p.now} run={run} onInspect={p.inspect} />;
}

function Frame({ p, id, children, aside = true }: { p: LayoutProps; id: string; children: ReactNode; aside?: boolean }) {
  return (
    <div className="lab-frame" data-layout={id}>
      <div className="lab-main">{children}</div>
      {aside && <aside className="lab-aside" aria-label="Selected quest"><Detail {...p} /></aside>}
    </div>
  );
}

const Scene = ({ p, compact }: { p: LayoutProps; compact?: boolean }) => (
  <LoopScene views={p.world.views} selected={p.selected?.id} current={p.selected?.view.stage.id} narrow={p.narrow} compact={compact}
    onSelect={p.select} />
);
const Groups = ({ p }: { p: LayoutProps }) => (
  <QuestGroups views={p.world.views} selected={p.selected?.id} narrow={p.narrow} row={p.row} meter={p.meter} onSelect={p.select} />
);

// ───────────────────────── A · Water column ─────────────────────────
function WaterColumn(p: LayoutProps) {
  return (
    <Frame p={p} id="a">
      <FleetSentence fleet={p.world.fleet} />
      <Scene p={p} />
      <Needs {...p} />
    </Frame>
  );
}

// ───────────────────────── B · Loop dial ─────────────────────────
function LoopDial(p: LayoutProps) {
  const at = slots(p.world.views);
  const view = p.selected?.view ?? null;
  const size = p.narrow ? 34 : 44;
  return (
    <div className="lab-frame" data-layout="b">
      <div className="lab-main">
        <FleetSentence fleet={p.world.fleet} />
        <Needs {...p} />
        <section className="lab-dial" data-plot aria-label="Every quest, around the loop">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="42" />
            {LOOP_STAGES.map((s) => (
              <line key={s.id} x1="50" y1="2" x2="50" y2="14" transform={`rotate(${(s.index * 360) / LOOP_STAGES.length} 50 50)`} />
            ))}
          </svg>
          <ol className="lab-dial-stages" aria-hidden="true">
            {LOOP_STAGES.map((s) => (
              <li key={s.id} style={vars({ "--a": ((s.index + 0.5) * 360) / LOOP_STAGES.length - 90 })}>
                <span>{p.narrow ? s.index + 1 : s.label}</span>
              </li>
            ))}
          </ol>
          <ul>
            {p.world.views.map((quest) => {
              const { slot, of } = at.get(quest.id)!;
              const angle = ((quest.stage.index + (slot + 1) / (of + 1)) * 360) / LOOP_STAGES.length - 90;
              const picked = quest.id === p.selected?.id;
              return (
                <li key={quest.id} data-quest={quest.short} data-stage={quest.stage.id} data-attention={quest.attention} data-retreats={quest.retreats}
                  data-selected={picked || undefined} style={vars({ "--a": angle.toFixed(2) })}>
                  <button type="button" aria-pressed={picked} onClick={() => p.select(quest.id)}
                    aria-label={`${quest.short}, ${ATTENTION_LABEL[quest.attention]}, ${quest.stage.label}. ${quest.title}. ${quest.headline}`}>
                    <Specimen quest={quest} size={size} />
                  </button>
                </li>
              );
            })}
          </ul>
          {view && (
            <div className="lab-dial-core" data-attention={view.attention}>
              <p className="lp-eyebrow"><span>{view.short}</span><span>{view.stage.label}</span></p>
              <p className="lab-dial-title">{view.title}</p>
              <p className="lab-dial-headline"><AttentionMark attention={view.attention} label={false} />{view.headline}</p>
            </div>
          )}
        </section>
      </div>
      <aside className="lab-aside" aria-label="Selected quest"><Detail {...p} /></aside>
    </div>
  );
}

// ───────────────────────── C · Logbook ─────────────────────────
function Logbook(p: LayoutProps) {
  const entries = p.world.quests
    .flatMap((quest) => quest.events.filter((event) => event.type !== "usage_recorded").map((event) => ({ quest, event })))
    .sort((a, b) => b.event.at.localeCompare(a.event.at) || b.event.id.localeCompare(a.event.id))
    .slice(0, 28);
  const active = [...p.world.views].sort(byAttention).filter((view) => view.group !== "finished");
  return (
    <Frame p={p} id="c">
      <FleetSentence fleet={p.world.fleet} />
      <Needs {...p} />
      <section className="lab-log-now">
        <h2>Right now</h2>
        <ul className="lp-rows" data-variant="sentence">
          {active.map((view, i) => (
            <QuestRow key={view.id} quest={view} variant="sentence" meter={p.meter} index={i} selected={view.id === p.selected?.id}
              onSelect={p.select} />
          ))}
        </ul>
      </section>
      <section className="lab-log">
        <h2>The last hour, newest first</h2>
        <ol>
          {entries.map(({ quest, event }, i) => {
            const persona = event.actor.kind === "agent" ? PERSONAS.find((x) => x.id === event.actor.id)?.id ?? null : null;
            return (
              <li key={event.id} data-type={event.type} data-same-time={clock(entries[i - 1]?.event.at ?? "") === clock(event.at) || undefined}>
                <time dateTime={event.at}>{clock(event.at)}</time>
                <span className="lab-log-id">{quest.view.short}</span>
                <span className="lab-log-text">{narrate(event)}</span>
                <span className="lab-log-who" title={personaName(persona) ?? undefined}>
                  {persona && <PersonaAvatar persona={persona} size={24} />}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </Frame>
  );
}

// ───────────────────────── D · Triage bench ─────────────────────────
function TriageBench(p: LayoutProps) {
  return (
    <Frame p={p} id="d">
      <FleetSentence fleet={p.world.fleet} />
      <Needs {...p} />
      <Groups p={p} />
    </Frame>
  );
}

// ───────────────────────── E · Tide map ─────────────────────────
function TideMap(p: LayoutProps) {
  const areas = [...new Set(p.world.views.map((view) => view.area))].sort();
  let index = 0;
  return (
    <Frame p={p} id="e">
      <FleetSentence fleet={p.world.fleet} />
      <Needs {...p} />
      <div className="lab-pools">
        {areas.map((area) => {
          const mine = p.world.views.filter((view) => view.area === area).sort(byAttention);
          const moving = mine.filter((view) => view.group === "self").length;
          return (
            <section key={area} className="lab-pool" data-area={area} data-size={Math.min(mine.length, 3)}
              data-loud={mine.some((view) => view.group === "you" || view.group === "stopped") || undefined}>
              <h2>{area}<span>{mine.length} {mine.length === 1 ? "quest" : "quests"}, {moving} moving</span></h2>
              <ul className="lp-rows" data-variant="card">
                {mine.map((view) => (
                  <QuestRow key={view.id} quest={view} variant="card" index={index++} selected={view.id === p.selected?.id}
                    onSelect={p.select} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Frame>
  );
}

// ───────────────────────── F · Stage lanes ─────────────────────────
function StageLanes(p: LayoutProps) {
  return (
    <Frame p={p} id="f">
      <FleetSentence fleet={p.world.fleet} />
      <Needs {...p} />
      <ol className="lab-lanes" aria-label="Every quest, by stage">
        {LOOP_STAGES.map((s) => {
          const here = p.world.views.filter((view) => view.stage.id === s.id).sort(byAttention);
          return (
            <li key={s.id} className="lab-lane" data-stage-head={s.id} data-empty={here.length === 0 || undefined}>
              <h2>
                <PersonaAvatar persona={s.persona} size={24} />
                <span>{s.label}</span>
                {s.gate && <abbr title={`Checkpoint ${s.gate}`}>{s.gate}</abbr>}
              </h2>
              <ul>
                {here.map((view) => {
                  const picked = view.id === p.selected?.id;
                  return (
                    <li key={view.id} data-quest={view.short} data-stage={view.stage.id} data-attention={view.attention} data-retreats={view.retreats}
                      data-selected={picked || undefined}>
                      <Specimen quest={view} size={40} />
                      <button type="button" aria-pressed={picked} onClick={() => p.select(view.id)}>{view.title}</button>
                      <AttentionMark attention={view.attention} />
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}

// ───────────────────────── H · Column and bench ─────────────────────────
function Hybrid(p: LayoutProps) {
  return (
    <Frame p={p} id="h">
      <FleetSentence fleet={p.world.fleet} />
      <Needs {...p} />
      <Scene p={p} compact />
      <Groups p={p} />
    </Frame>
  );
}

export const LAYOUTS = [
  { id: "a", name: "Water column", idea: "The loop as a place. Depth is distance from production.", view: WaterColumn },
  { id: "b", name: "Loop dial", idea: "The loop as a clock face with the selected quest at its centre.", view: LoopDial },
  { id: "c", name: "Logbook", idea: "The hour as sentences, newest first.", view: Logbook },
  { id: "d", name: "Triage bench", idea: "Quests grouped by who holds the next move.", view: TriageBench },
  { id: "e", name: "Tide map", idea: "Quests pooled by the area of the product they touch.", view: TideMap },
  { id: "f", name: "Stage lanes", idea: "One lane per stage, with checkpoints between them.", view: StageLanes },
  { id: "h", name: "Column and bench", idea: "The water column to glance at, the bench to act from.", view: Hybrid },
] as const;
export type LayoutId = (typeof LAYOUTS)[number]["id"];
