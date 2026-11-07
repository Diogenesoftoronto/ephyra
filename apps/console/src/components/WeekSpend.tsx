import type { UsageSummary } from "@ephyra/core";
import { Meter, Stat } from "../kit.ts";
import { formatMicrousd } from "../lib/format.ts";

const usd = (n: number) => formatMicrousd(Math.round(n));

/** Spend in the window against the budgets of the trails that spent in it. Unknown costs are counted beside it, not inside it. */
export function WeekSpend({
  usage,
  label = "Recorded spend this week",
}: {
  usage: UsageSummary;
  label?: string;
}) {
  const budget = usage.byTrail.reduce((n, t) => n + t.budget.spendMicrousdMax, 0);
  return (
    <div className="stack-sm">
      <Stat
        label={label}
        value={formatMicrousd(usage.totals.costMicrousd)}
        unknownCount={usage.totals.unknownCost}
        sub={budget > 0 ? `across ${usage.byTrail.length} trail budgets` : "no trail budgets in this window"}
      />
      {budget > 0 && (
        <Meter
          label="Against trail budgets"
          used={usage.totals.costMicrousd}
          max={budget}
          unknown={usage.totals.unknownCost}
          format={usd}
        />
      )}
    </div>
  );
}
