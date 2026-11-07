import type { UsageSummary } from "@ephyra/core";
import { Meter, Stat } from "../kit.ts";
import { formatMicrousd } from "../lib/format.ts";
import "./WeekSpend.css";

/** Spend in the window against the budgets of the trails that spent in it. Unknown costs are counted beside it, not inside it. */
export function WeekSpend({ usage, label = "Spend this week" }: { usage: UsageSummary; label?: string }) {
  const budget = usage.byTrail.reduce((n, t) => n + t.budget.spendMicrousdMax, 0);
  const { costMicrousd, unknownCount } = { costMicrousd: usage.totals.costMicrousd, unknownCount: usage.totals.unknownCost };
  return (
    <div className="week-spend">
      <Stat label={label} value={formatMicrousd(costMicrousd)} unknownCount={unknownCount}
        sub={budget > 0 ? `of ${formatMicrousd(budget)} across ${usage.byTrail.length} trail budgets` : "no trail budgets in this window"} />
      {budget > 0 && <Meter label={`${label} against trail budgets`} used={costMicrousd} max={budget} unknown={unknownCount} />}
    </div>
  );
}
