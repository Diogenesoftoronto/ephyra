import { useId, useRef, useState, type PointerEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { AUTONOMY_LEVELS, type AutonomyLevel, type AreaSketch } from "@ephyra/core";
import { Badge, Tag } from "../kit.ts";
import { haptic, segmentAt, TAP_SLOP } from "../lib/gesture.ts";
import "./AutonomyLadder.css";

/**
 * The five-step ladder: Watch, Research, Propose, Patch, Auto-land. A thumb slides to the chosen step. Drag or scrub
 * along the track to move it (each step ticks under the finger), or tap a step, or use the arrow keys: underneath it is
 * still one radio group, so screen readers and keyboards get the native control.
 */
export function AutonomyLadder({
  value,
  onChange,
  risk,
  label = "Autonomy level",
}: {
  value: AutonomyLevel;
  onChange?: (level: AutonomyLevel) => void;
  risk?: AreaSketch["risk"];
  label?: string;
}) {
  const current = AUTONOMY_LEVELS.find((l) => l.id === value)!;
  return (
    <div className="ladder">
      {onChange ? <LadderTrack label={label} value={value} onChange={onChange} /> : (
        <p className="ladder-read">
          <Badge tone="info">{current.label}</Badge> <span className="muted">{current.means}</span>
        </p>
      )}
      {value === "auto" && risk === "critical" && (
        <Badge tone="warn">Auto-land on a critical area: proven changes land with no person involved.</Badge>
      )}
    </div>
  );
}

function LadderTrack({ label, value, onChange }: { label: string; value: AutonomyLevel; onChange: (l: AutonomyLevel) => void }) {
  const id = useId();
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean; pointer: number } | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const index = AUTONOMY_LEVELS.findIndex((l) => l.id === value);
  const shown = scrub ?? index;
  const at = (event: PointerEvent) => {
    const box = track.current!.getBoundingClientRect();
    return segmentAt(event.clientX - box.left, box.width, AUTONOMY_LEVELS.length);
  };

  return (
    <fieldset className="ui-seg ladder-seg">
      <legend><Tag>{label}</Tag></legend>
      <div
        ref={track}
        className="track ladder-track"
        data-scrubbing={scrub !== null ? "" : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, moved: false, pointer: event.pointerId };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || d.pointer !== event.pointerId) return;
          if (!d.moved && Math.abs(event.clientX - d.x) < TAP_SLOP) return;
          if (!d.moved) { d.moved = true; event.currentTarget.setPointerCapture?.(event.pointerId); }
          const next = at(event);
          if (next !== shown) haptic(4);
          setScrub(next);
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          if (!d?.moved) return; // A tap: the radio underneath handles it.
          const next = at(event);
          setScrub(null);
          if (next !== index) { haptic(10); onChange(AUTONOMY_LEVELS[next]!.id); }
        }}
        onPointerCancel={() => { drag.current = null; setScrub(null); }}
      >
        {AUTONOMY_LEVELS.map((l, i) => (
          <label key={l.id} data-on={i === shown ? "" : undefined}>
            {i === shown && <motion.span className="ladder-thumb" aria-hidden="true" layoutId={`ladder-thumb-${id}`}
              animate={{ scale: scrub !== null ? 1.05 : 1 }}
              transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 34, mass: 0.7 }} />}
            <input type="radio" name={id} value={l.id} checked={l.id === value}
              onChange={() => { haptic(8); onChange(l.id); }} />
            <span className="opt">{l.label}</span>
          </label>
        ))}
      </div>
      <p className="hint" aria-live="polite">{AUTONOMY_LEVELS[shown]!.means}</p>
    </fieldset>
  );
}
