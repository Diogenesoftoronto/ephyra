import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FLING_PX, holdProgress, segmentAt, sheetShouldClose, SHEET_CLOSE_PX, swipeOutcome, swipeProgress, TAP_SLOP } from "./gesture.ts";

const px = fc.double({ min: -2000, max: 2000, noNaN: true });
const width = fc.double({ min: 200, max: 1400, noNaN: true });

describe("gestures", () => {
  test("a swipe commits in the direction it moved, and never below the fling distance", () => {
    fc.assert(fc.property(px, px, width, (offset, velocity, w) => {
      const out = swipeOutcome(offset, velocity, w);
      if (Math.abs(offset) < FLING_PX) expect(out).toBeNull();
      if (out) expect(out).toBe(offset > 0 ? "right" : "left");
    }));
  });

  test("dragging further never un-commits a slow swipe", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }), width, (a, extra, w) => {
      if (swipeOutcome(a, 0, w)) expect(swipeOutcome(a + extra, 0, w)).toBe("right");
      if (swipeOutcome(-a, 0, w)) expect(swipeOutcome(-a - extra, 0, w)).toBe("left");
    }));
  });

  test("a fling against the drag direction does not commit a short swipe", () => {
    expect(swipeOutcome(60, -900, 1000)).toBeNull();
    expect(swipeOutcome(60, 900, 1000)).toBe("right");
  });

  test("swipe and hold progress stay within 0..1", () => {
    fc.assert(fc.property(px, width, fc.double({ noNaN: false }), fc.double({ min: -10, max: 5000, noNaN: true }), (o, w, e, d) => {
      const s = swipeProgress(o, w);
      const h = holdProgress(e, d);
      expect(s >= 0 && s <= 1).toBe(true);
      expect(h >= 0 && h <= 1).toBe(true);
    }));
  });

  test("segmentAt always lands on a real segment and is monotonic", () => {
    fc.assert(fc.property(px, px, width, fc.integer({ min: 1, max: 8 }), (a, b, w, n) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const i = segmentAt(lo, w, n), j = segmentAt(hi, w, n);
      expect(i >= 0 && i < n && j >= 0 && j < n).toBe(true);
      expect(i).toBeLessThanOrEqual(j);
    }));
  });

  test("a sheet closes when pulled far or flicked down, never on a tap or an upward pull", () => {
    fc.assert(fc.property(px, px, (o, v) => {
      const close = sheetShouldClose(o, v);
      if (o <= TAP_SLOP) expect(close).toBe(false);
      if (o >= SHEET_CLOSE_PX) expect(close).toBe(true);
    }));
  });
});
