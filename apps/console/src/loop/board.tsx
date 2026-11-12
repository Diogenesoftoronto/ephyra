// The board: every quest at once. The scene shows where each one is in the loop; the bench groups them by who holds
// the next move. The lab and the console draw the same board from the same view-models.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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

type HeadsProps = {
  views: readonly QuestView[]; current?: StageId;
  /** Too little room for eight names: only the current stage is named. */
  narrow: boolean;
  /** Whether to mark the checkpoints. They fit wherever the names do not. Defaults to whenever there is room for names. */
  gates?: boolean;
};

export function StageHeads({ views, narrow, current, gates = !narrow }: HeadsProps) {
  return (
    <ol className="lp-stages" aria-label="The loop, stage by stage">
      {LOOP_STAGES.map((s) => {
        const here = views.filter((view) => view.stage.id === s.id).length;
        return (
          <li key={s.id} data-stage-head={s.id} data-busy={here > 0 || undefined} data-current={s.id === current || undefined}>
            <PersonaAvatar persona={s.persona} size={24} />
            {/* A phone has room for one name: the stage of the quest you are looking at. */}
            <span className={narrow && s.id !== current ? "sr-only" : undefined}>{s.label}</span>
            {s.gate && gates && <abbr title={`Checkpoint ${s.gate}`}>{s.gate}</abbr>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How many times each quest has moved since the board was first drawn. A quest that changes stage or status, or that
 * appears, gets one ripple where it now is. Nothing ripples for what was already there when the page opened.
 */
function useMoves(views: readonly QuestView[]): ReadonlyMap<string, number> {
  const seen = useRef<Map<string, string> | null>(null);
  const [moves, setMoves] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    const was = seen.current;
    const now = new Map(views.map((view) => [view.id, `${view.stage.id}:${view.attention}`]));
    seen.current = now;
    if (!was) return;
    const moved = views.filter((view) => was.get(view.id) !== now.get(view.id)).map((view) => view.id);
    if (!moved.length) return;
    setMoves((before) => {
      const next = new Map(before);
      for (const id of moved) next.set(id, (next.get(id) ?? 0) + 1);
      return next;
    });
  }, [views]);
  return moves;
}

/** Where a quest is drawn, in pixels inside the field: its centre, its specimen's size, and how wide its tag is. */
export type Spot = { id: string; cx: number; cy: number; size: number; width: number };
type Box = { left: number; right: number; top: number; bottom: number };
const TAG_HEIGHT = 18;
const tagBox = (spot: Spot, side: "above" | "below"): Box => {
  const top = side === "below" ? spot.cy + spot.size / 2 - 6 : spot.cy - spot.size / 2 - 12;
  return { left: spot.cx - spot.width / 2, right: spot.cx + spot.width / 2, top, bottom: top + TAG_HEIGHT };
};
const touching = (a: Box, b: Box) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/**
 * Which side of its specimen each quest's tag sits on. A tag goes underneath. Where that would land on a tag already
 * placed, it goes above instead, if there is room there. Quests are placed left to right, so the result is stable.
 */
export function tagSides(spots: readonly Spot[]): Map<string, "above" | "below"> {
  const sides = new Map<string, "above" | "below">();
  const placed: Box[] = [];
  for (const spot of [...spots].sort((a, b) => a.cx - b.cx || a.cy - b.cy || a.id.localeCompare(b.id))) {
    const free = (box: Box) => !placed.some((other) => touching(box, other));
    const side = free(tagBox(spot, "below")) || !free(tagBox(spot, "above")) ? "below" : "above";
    sides.set(spot.id, side);
    placed.push(tagBox(spot, side));
  }
  return sides;
}

/** The size of an element, kept current. It starts from a likely size, so the first paint is already close. */
function useSize(initial: { width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize((was) => (was.width === next.width && was.height === next.height ? was : next));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

type SceneProps = {
  views: readonly QuestView[]; selected?: string | null; current?: StageId; narrow: boolean; compact?: boolean;
  onSelect: (id: string) => void;
};

/** The water column: left to right is progress, top to bottom is distance from production. */
export function LoopScene({ views, selected, current, narrow, compact, onSelect }: SceneProps) {
  const at = slots(views);
  const moves = useMoves(views);
  const size = narrow ? 36 : compact ? 48 : 56;
  const place = (view: QuestView) => {
    const point = loopPoint(view.progress);
    return { point, slot: at.get(view.id)!.slot * (point.depth > 0.5 ? -1 : 1) };
  };
  // The same arithmetic the stylesheet does to place a quest, so tags can be kept off each other.
  // On a phone the tag is a badge on the specimen's shoulder, so there is nothing to keep apart.
  const [field, box] = useSize({ width: 712, height: 232 });
  const pad = compact ? 40 : 48;
  // With too little room for every name, only the selected quest keeps its name; the rest keep their status glyph.
  // The names are in the list underneath either way.
  const dense = !narrow && box.width / Math.max(1, views.length) < 76;
  const named = (view: QuestView) => !narrow && (!dense || view.id === selected);
  const sides = narrow ? null : tagSides(views.map((view) => {
    const { point, slot } = place(view);
    return {
      id: view.id, size, width: named(view) ? 34 + view.short.length * 6.6 : 26,
      cx: Math.min(Math.max(point.x * box.width, 56), box.width - 56),
      cy: pad + point.depth * (box.height - 2 * pad) + slot * (size + 20),
    };
  }));
  return (
    <section className="lp-scene" data-compact={compact || undefined} aria-label="Every quest, by where it is in the loop">
      {/* Eight stage names need about 72 px each. With less, only the current one is spelled out. */}
      <StageHeads views={views} narrow={narrow || box.width < 580} gates={!narrow} current={current} />
      <div className="lp-scene-field" data-plot ref={field} style={vars({ "--pitch": `${size + (narrow ? 8 : 20)}px` })}>
        <span className="lp-scene-level" data-level="surface">production</span>
        <span className="lp-scene-level" data-level="seabed">git</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points={LOOP_PATH} /></svg>
        <ul>
          {views.map((view) => {
            const { point, slot } = place(view);
            const picked = view.id === selected;
            return (
              <li key={view.id} data-quest={view.short} data-stage={view.stage.id} data-attention={view.attention}
                data-retreats={view.retreats} data-selected={picked || undefined} data-tag={sides?.get(view.id)}
                style={vars({ "--x": point.x.toFixed(4), "--y": point.depth.toFixed(4), "--slot": slot })}>
                <button type="button" aria-pressed={picked} onClick={() => onSelect(view.id)}
                  aria-label={`${view.short}, ${ATTENTION_LABEL[view.attention]}, ${view.stage.label}. ${view.title}. ${view.headline}`}>
                  {moves.get(view.id) ? <i className="lp-scene-ripple" key={moves.get(view.id)} aria-hidden="true" /> : null}
                  <Specimen quest={view} size={size} />
                  <span className="lp-scene-tag"><AttentionMark attention={view.attention} label={false} />{named(view) && view.short}</span>
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
        // Whatever finished last is what someone is most likely looking for, so finished quests read newest first.
        if (group === "finished") mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
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
