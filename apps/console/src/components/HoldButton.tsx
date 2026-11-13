import { useEffect, useRef, useState, type ButtonHTMLAttributes, type PointerEvent } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { Button } from "../kit.ts";
import { haptic, HOLD_MS } from "../lib/gesture.ts";
import "./HoldButton.css";

/**
 * A button that, on a touchscreen, confirms by press-and-hold: a fill sweeps across while the finger stays down,
 * lifting early cancels, and the action fires once the fill completes. Mouse clicks and the keyboard act at once,
 * because a click or Enter is already deliberate, and a hold would be impossible for switch and screen-reader users.
 */
export function HoldButton({
  onConfirm, children, holdLabel = "Hold", variant = "primary", size, loading, disabled, durationMs = HOLD_MS, className, ...rest
}: {
  onConfirm: () => void;
  /** Replaces the label while holding, e.g. "Hold to approve". */
  holdLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  durationMs?: number;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const reduced = useReducedMotion();
  const progress = useMotionValue(0);
  const fill = useTransform(progress, [0, 1], ["0%", "100%"]);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const touch = useRef(false);
  const fired = useRef(false);
  useEffect(() => () => anim.current?.stop(), []);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 1600);
    return () => clearTimeout(t);
  }, [hint]);

  const cancel = () => {
    if (!holding) return;
    setHolding(false);
    anim.current?.stop();
    anim.current = animate(progress, 0, reduced ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 });
  };
  const start = (event: PointerEvent<HTMLButtonElement>) => {
    touch.current = event.pointerType === "touch" || event.pointerType === "pen";
    if (!touch.current || disabled || loading || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setHolding(true);
    setHint(false);
    fired.current = false;
    haptic(6);
    anim.current?.stop();
    anim.current = animate(progress, 1, { duration: durationMs / 1000, ease: "linear" });
    anim.current.then(() => {
      if (progress.get() < 1) return;
      setHolding(false);
      fired.current = true;
      haptic([10, 40, 18]);
      onConfirm();
      animate(progress, 0, { duration: reduced ? 0 : 0.35, delay: reduced ? 0 : 0.15 });
    });
  };

  return (
    <Button
      {...rest}
      variant={variant}
      size={size}
      loading={loading}
      disabled={disabled}
      className={["hold", holding && "hold--active", className].filter(Boolean).join(" ")}
      data-holding={holding ? "" : undefined}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(event) => { if (touch.current) event.preventDefault(); }}
      onClick={(event) => {
        // A touch that ends before the hold completes is a hint, not an action.
        if (touch.current) {
          touch.current = false;
          event.preventDefault();
          if (!fired.current) setHint(true);
          fired.current = false;
          return;
        }
        onConfirm();
      }}
    >
      <motion.span className="hold__fill" aria-hidden="true" style={{ width: fill }} />
      <span className="hold__label">{holding || hint ? holdLabel : children}</span>
      <span className="sr-only" role="status" aria-live="polite">{hint ? `Press and hold to ${String(children).toLowerCase()}.` : ""}</span>
    </Button>
  );
}
