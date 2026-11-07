import type { UsageTotals } from "@ephyra/core";
import { Stat } from "../kit.ts";
import { formatDuration, formatMicrousd, formatTokens } from "../lib/format.ts";

/** Totals for a window. Failed and unavailable work are shown, not hidden in the entry count. */
export function UsageStats({ totals }: { totals: UsageTotals }) {
  return (
    <div className="grid-stats">
      <Stat label="Spend (known costs)" value={formatMicrousd(totals.costMicrousd)} unknownCount={totals.unknownCost} />
      <Stat label="Tokens" value={formatTokens(totals.tokens)} />
      <Stat label="Agent time" value={formatDuration(totals.wallMs)} />
      <Stat label="Entries" value={totals.entries} />
      <Stat label="Failed" value={totals.failed} tone={totals.failed ? "bad" : undefined} />
      <Stat label="Unavailable" value={totals.unavailable} tone={totals.unavailable ? "warn" : undefined} />
    </div>
  );
}
