import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { UsageSummary } from "@ephyra/core";
import { Segmented } from "../kit.ts";
import { formatMicrousd } from "../lib/format.ts";
import { outlook } from "../lib/quest-cost.ts";
import "./SpendOutlook.css";

const unpriced = (n: number) => n === 1
  ? "1 entry has no recorded price and is not included."
  : `${n} entries have no recorded price and are not included.`;
const HORIZONS = [
  { id: "30", label: "30 days" }, { id: "90", label: "Quarter" }, { id: "180", label: "6 months" }, { id: "365", label: "Year" },
] as const;

/**
 * How much the next month, quarter, half or year would cost at the recorded pace. It is arithmetic on the ledger, so
 * it is labelled a projection, bracketed by the quietest and busiest week, and kept apart from the model forecast.
 */
export function SpendOutlook({ days, today }: { days: UsageSummary["byDay"]; today: string }) {
  const [h, setH] = useState<(typeof HORIZONS)[number]["id"]>("90");
  const reduced = useReducedMotion();
  const o = outlook(days, today, Number(h));
  return (
    <div className="outlook">
      <Segmented label="Horizon" value={h} onChange={(v) => setH(v)} options={[...HORIZONS]} />
      {o === null ? (
        <p className="muted">A projection needs at least a full week of recorded spend.</p>
      ) : (
        <>
          <div className="outlook__figure" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={h} className="outlook__value"
                initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}>
                {formatMicrousd(o.expected)}
              </motion.span>
            </AnimatePresence>
            <span className="outlook__range">{formatMicrousd(o.low)} to {formatMicrousd(o.high)}</span>
          </div>
          <div className="outlook__bar" aria-hidden="true">
            <span style={{ left: `${o.high ? (o.low / o.high) * 100 : 0}%`, right: 0 }} />
            <i style={{ left: `${o.high ? (o.expected / o.high) * 100 : 0}%` }} />
          </div>
          <p className="outlook__note">
            At {formatMicrousd(Math.round(o.daily))} a day, your average over the last {o.historyDays} complete days. The range runs from
            your quietest week's pace to your busiest. This is a projection from your own ledger, not a forecast.
            {o.unknownCost > 0 && ` ${unpriced(o.unknownCost)}`}
          </p>
        </>
      )}
    </div>
  );
}
