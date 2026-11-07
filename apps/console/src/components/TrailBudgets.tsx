import type { UsageSummary } from "@ephyra/core";
import { Badge, Empty, Meter } from "../kit.ts";
import { formatMicrousd, formatTokens } from "../lib/format.ts";
import "./TrailBudgets.css";

/** Each trail's spend and tokens as used / max. Over 90% turns the bar hot. */
export function TrailBudgets({ trails }: { trails: UsageSummary["byTrail"] }) {
  if (trails.length === 0) return <Empty title="No trail spent anything in this window" />;
  return (
    <ul className="trail-budgets">
      {trails.map((t) => (
        <li key={t.trailId} className="trail-budget">
          <div className="trail-budget-head">
            <a href={`#/inbox/${t.trailId}`} className="mono">{t.short}</a>
            <span className="trail-budget-title">{t.title}</span>
            {t.totals.unknownCost > 0 && <Badge tone="warn">{t.totals.unknownCost} unknown</Badge>}
          </div>
          <div className="trail-budget-bars">
            <div><span className="muted">Spend {formatMicrousd(t.budget.spendMicrousdUsed)} of {formatMicrousd(t.budget.spendMicrousdMax)}</span>
              <Meter label={`${t.short} spend`} used={t.budget.spendMicrousdUsed} max={t.budget.spendMicrousdMax} /></div>
            <div><span className="muted">Tokens {formatTokens(t.budget.tokensUsed)} of {formatTokens(t.budget.tokensMax)}</span>
              <Meter label={`${t.short} tokens`} used={t.budget.tokensUsed} max={t.budget.tokensMax} /></div>
          </div>
        </li>
      ))}
    </ul>
  );
}
