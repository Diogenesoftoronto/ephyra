// The board: every quest at once. The scene shows where each one is in the loop; the bench groups them by who holds
// the next move. The lab and the console draw the same board from the same view-models.
import { useState, type CSSProperties } from "react";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import {
  ATTENTION_LABEL, LOOP_STAGES, byAttention, loopPoint, type AttentionGroup, type QuestView, type StageId,
} from "./model.ts";
import { AttentionMark, QuestRow, Specimen, type MeterVariant, type RowVariant } from "./parts.tsx";
import "./board.css";

const vars = (values: Record<string, string | number>) => values as CSSProperties;
const oldestFirst = (a: QuestView, b: QuestView) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Which of the quests sharing a stage this one is, oldest first, and how many share it. */
export function slots(views: readonly QuestView[]): Map<string, { slot: number; of: number }> {
  const count = new Map<StageId, number>();
  const out = new Map<string, { slot: number; of: number }>();
  for (const view of [...views].sort(oldestFirst)) {
    const slot = count.get(view.stage.id) ?? 0;
    count.set(view.stage.id, slot + 1);
    out.set(view.id, { slot, of: 0 });
  }
  for (const view of views) out.get(view.id)!.of = count.get(view.stage.id)!;
  return out;
}

const LOOP_PATH = Array.from({ length: 65 }, (_, i) => {
  const point = loopPoint(i / 64);
  return `${(point.x * 100).toFixed(2)},${(point.depth * 100).toFixed(2)}`;
}).join(" ");

export function StageHeads({ views, narrow, current }: { views: readonly QuestView[]; narrow: boolean; current?: StageId }) {
  return (
    <ol className="lp-stages" aria-label="The loop, stage by stage">
      {LOOP_STAGES.map((s) => {
        const here = views.filter((view) => view.stage.id === s.id).length;
        return (
          <li key={s.id} data-stage-head={s.id} data-busy={here > 0 || undefined} data-current={s.id === current || undefined}>
            <PersonaAvatar persona={s.persona} size={24} />
            {/* A phone has room for one name: the stage of the quest you are looking at. */}
            <span className={narrow && s.id !== current ? "sr-only" : undefined}>{s.label}</span>
            {s.gate && !narrow && <abbr title={`Checkpoint ${s.gate}`}>{s.gate}</abbr>}
          </li>
        );
      })}
    </ol>
  );
}

type SceneProps = {
  views: readonly QuestView[]; selected?: string | null; current?: StageId; narrow: boolean; compact?: boolean;
  onSelect: (id: string) => void;
};

/** The water column: left to right is progress, top to bottom is distance from production. */
export function LoopScene({ views, selected, current, narrow, compact, onSelect }: SceneProps) {
  const at = slots(views);
  const size = narrow ? 36 : compact ? 48 : 56;
  return (
    <section className="lp-scene" data-compact={compact || undefined} aria-label="Every quest, by where it is in the loop">
      <StageHeads views={views} narrow={narrow} current={current} />
      <div className="lp-scene-field" data-plot style={vars({ "--pitch": `${size + (narrow ? 8 : 20)}px` })}>
        <span className="lp-scene-level" data-level="surface">production</span>
        <span className="lp-scene-level" data-level="seabed">git</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={LOOP_PATH} /></svg>
        <ul>
          {views.map((view) => {
            const point = loopPoint(view.progress);
            const slot = at.get(view.id)!.slot * (point.depth > 0.5 ? -1 : 1);
            const picked = view.id === selected;
            return (
              <li key={view.id} data-quest={view.short} data-stage={view.stage.id} data-attention={view.attention}
                data-retreats={view.retreats} data-selected={picked || undefined}
                style={vars({ "--x": point.x.toFixed(4), "--y": point.depth.toFixed(4), "--slot": slot })}>
                <button type="button" aria-pressed={picked} onClick={() => onSelect(view.id)}
                  aria-label={`${view.short}, ${ATTENTION_LABEL[view.attention]}, ${view.stage.label}. ${view.title}. ${view.headline}`}>
                  <Specimen quest={view} size={size} />
                  <span className="lp-scene-tag"><AttentionMark attention={view.attention} label={false} />{!narrow && view.short}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * What the scene draws: every quest in flight, and only the few most recently finished. Finished quests never leave, so
 * drawing all of them would bury the ones still moving under a pile at the end of the loop.
 */
export function sceneViews(views: readonly QuestView[], finished = 3): QuestView[] {
  const done = views.filter((view) => view.group === "finished").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const keep = new Set(done.slice(0, finished).map((view) => view.id));
  return views.filter((view) => view.group !== "finished" || keep.has(view.id));
}

const GROUPS: [AttentionGroup, string][] = [
  ["you", "Needs you"], ["self", "Moving by itself"], ["stopped", "Stopped"], ["finished", "Finished"],
];

type GroupsProps = {
  views: readonly QuestView[]; selected?: string | null; narrow: boolean; row?: RowVariant | null; meter?: MeterVariant;
  /** How many finished quests to list before the rest fold away. Unset lists them all. */
  finished?: number;
  onSelect: (id: string) => void;
};

/** The bench: quests grouped by who holds the next move. */
export function QuestGroups({ views, selected, narrow, row, meter = "path", finished, onSelect }: GroupsProps) {
  const [all, setAll] = useState(false);
  const variant = row ?? (narrow ? "sentence" : "strip");
  const sorted = [...views].sort(byAttention);
  let index = 0;
  return (
    <div className="lp-groups">
      {GROUPS.map(([group, label]) => {
        const mine = sorted.filter((view) => view.group === group);
        if (!mine.length) return null;
        // The selected quest is always listed, so choosing one in the scene never points at a row that is not there.
        const fold = group === "finished" && finished !== undefined && !all && mine.length > finished;
        const shown = fold ? mine.filter((view, i) => i < finished! || view.id === selected) : mine;
        return (
          <section key={group} data-group={group}>
            <h2>{label}<span>{mine.length}</span></h2>
            <ul className="lp-rows" data-variant={variant}>
              {shown.map((view) => (
                <QuestRow key={view.id} quest={view} variant={variant} meter={meter} index={index++} selected={view.id === selected}
                  onSelect={onSelect} />
              ))}
            </ul>
            {group === "finished" && finished !== undefined && mine.length > finished && (
              <button type="button" className="lp-quiet lp-groups-more" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? "Show fewer" : `Show all ${mine.length} finished`}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
