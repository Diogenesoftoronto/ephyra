/**
 * The decisions behind touch gestures, kept pure so they can be tested without a browser. Components feed in the
 * numbers Motion reports (offset and velocity in px and px/s) and act on the result.
 */

/** How long a press-and-hold takes to confirm. Long enough to be deliberate, short enough to stay quick. */
export const HOLD_MS = 650;
/** A swipe commits past this share of the row's width, or past `FLING_PX` when flicked faster than `FLING_V`. */
export const SWIPE_SHARE = 0.32;
export const FLING_PX = 48;
export const FLING_V = 550;
/** A sheet closes when dragged down past this, or flicked down. */
export const SHEET_CLOSE_PX = 110;
/** Movement under this is a tap, not a drag, so the tap still activates links. */
export const TAP_SLOP = 6;

export type SwipeOutcome = "right" | "left" | null;

export function swipeOutcome(offset: number, velocity: number, width: number): SwipeOutcome {
  if (!Number.isFinite(offset) || !Number.isFinite(velocity)) return null;
  const far = Math.abs(offset) >= Math.max(FLING_PX, width * SWIPE_SHARE);
  const flung = Math.abs(offset) >= FLING_PX && Math.abs(velocity) >= FLING_V && Math.sign(velocity) === Math.sign(offset);
  if (!far && !flung) return null;
  return offset > 0 ? "right" : "left";
}

/** 0 → 1 while a reveal is being dragged toward commit; reaching 1 is the moment to give a haptic tick. */
export function swipeProgress(offset: number, width: number): number {
  const at = Math.max(FLING_PX, width * SWIPE_SHARE);
  return Math.min(1, Math.abs(offset) / at);
}

export function holdProgress(elapsedMs: number, durationMs = HOLD_MS): number {
  if (!(durationMs > 0) || !Number.isFinite(elapsedMs)) return 0;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

export function sheetShouldClose(offset: number, velocity: number): boolean {
  return offset >= SHEET_CLOSE_PX || (offset > TAP_SLOP * 4 && velocity >= FLING_V);
}

/** Which of `count` equal segments a pointer at `x` (relative to the track's left) is over. Always a valid index. */
export function segmentAt(x: number, width: number, count: number): number {
  if (count <= 0) return 0;
  if (!(width > 0) || !Number.isFinite(x)) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** A short buzz on devices that support it. Silently does nothing elsewhere (iOS Safari has no Vibration API). */
export function haptic(pattern: number | number[] = 8): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    // Some browsers throw when vibration is blocked by a permission policy.
  }
}
