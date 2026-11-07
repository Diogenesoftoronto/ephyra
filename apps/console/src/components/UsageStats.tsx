import type { UsageTotals } from "@ephyra/core";
import { Stat, Stats } from "../kit.ts";
import { formatDuration, formatMicrousd, formatTokens } from "../lib/format.ts";

/** Totals for a window. Failed and unavailable work are shown, not hidden in the entry count. */
export function UsageStats({ totals }: { totals: UsageTotals }) {
  return (
    <Stats>
      <Stat
        label="Recorded spend"
        value={formatMicrousd(totals.costMicrousd)}
        unknownCount={totals.unknownCost}
      />
      <Stat label="Tokens" value={formatTokens(totals.tokens)} sub={`${totals.entries} entries`} />
      <Stat label="Agent time" value={formatDuration(totals.wallMs)} />
      <Stat
        label="Failed or unavailable"
        value={totals.failed + totals.unavailable}
        tone={totals.failed ? "bad" : undefined}
        sub={`${totals.failed} failed · ${totals.unavailable} unavailable`}
      />
    </Stats>
  );
}
