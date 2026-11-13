import { useRef, useState, type ReactNode } from "react";
import { animate, motion, useDragControls, useMotionValue, useReducedMotion, useTransform, type PanInfo } from "motion/react";
import { haptic, swipeOutcome, swipeProgress } from "../lib/gesture.ts";
import "./SwipeRow.css";

export interface SwipeAction {
  label: string;
  /** Short glyph shown under the row as it is revealed. */
  icon: ReactNode;
  tone: "go" | "calm";
  onCommit: () => void;
}

/**
 * A list row that can be dragged sideways with a finger or pen (a mouse keeps selecting text) to reveal and commit an
 * action. The same actions are always reachable as ordinary links or buttons inside the row, so the swipe is a shortcut, never the only way.
 * Vertical scrolling keeps working: the row only claims horizontal drags.
 */
export function SwipeRow({ children, right, left, className }: {
  children: ReactNode;
  /** Revealed when dragging right (finger moves →). */
  right?: SwipeAction;
  /** Revealed when dragging left (finger moves ←). */
  left?: SwipeAction;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const row = useRef<HTMLDivElement>(null);
  const armed = useRef<"right" | "left" | null>(null);
  const dragged = useRef(0);
  const controls = useDragControls();
  const [side, setSide] = useState<"right" | "left" | null>(null);
  const width = () => row.current?.getBoundingClientRect().width ?? 360;
  const reveal = useTransform(x, (v) => swipeProgress(v, width()));
  const iconScale = useTransform(reveal, [0, 0.6, 1], [0.6, 0.9, 1.15]);
  const action = side === "right" ? right : side === "left" ? left : undefined;

  const settle = () => animate(x, 0, reduced ? { duration: 0 } : { type: "spring", stiffness: 600, damping: 38 });
  const onDrag = (_: unknown, info: PanInfo) => {
    dragged.current = Date.now();
    const dir = info.offset.x > 0 ? "right" : info.offset.x < 0 ? "left" : null;
    if (dir !== side) setSide(dir);
    const full = swipeProgress(info.offset.x, width()) >= 1 ? dir : null;
    if (full && armed.current !== full) haptic(10);
    armed.current = full;
  };
  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragged.current = Date.now();
    const out = swipeOutcome(info.offset.x, info.velocity.x, width());
    const chosen = out === "right" ? right : out === "left" ? left : undefined;
    armed.current = null;
    if (!chosen) { settle(); return; }
    haptic([8, 30, 14]);
    const off = (out === "right" ? 1 : -1) * width() * 0.6;
    void animate(x, off, reduced ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 34 }).then(() => {
      chosen.onCommit();
      settle();
    });
  };

  if (!right && !left) return <div className={className}>{children}</div>;
  return (
    <div ref={row} className={["swipe", className].filter(Boolean).join(" ")}>
      {action && (
        <motion.div className="swipe__under" data-side={side} data-tone={action.tone} aria-hidden="true"
          style={{ opacity: reveal }}>
          <motion.span className="swipe__icon" style={{ scale: iconScale }}>{action.icon}</motion.span>
          <span>{action.label}</span>
        </motion.div>
      )}
      <motion.div
        className="swipe__face"
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragListener={false}
        dragControls={controls}
        onPointerDown={(event) => { if (event.pointerType !== "mouse") controls.start(event); }}
        onClickCapture={(event) => {
          // The click that ends a drag is not a tap on whatever link was under the finger.
          if (Date.now() - dragged.current < 350) { event.preventDefault(); event.stopPropagation(); }
        }}
        dragConstraints={{ left: left ? -Infinity : 0, right: right ? Infinity : 0 }}
        dragElastic={{ left: left ? 0.35 : 0.08, right: right ? 0.35 : 0.08 }}
        dragMomentum={false}
        dragSnapToOrigin={false}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        whileDrag={{ cursor: "grabbing" }}
      >
        {children}
      </motion.div>
    </div>
  );
}
