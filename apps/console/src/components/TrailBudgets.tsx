import type { UsageSummary } from "@ephyra/core";
import { Empty, Meter } from "../kit.ts";
import { formatMicrousd, formatTokens } from "../lib/format.ts";

const usd = (n: number) => formatMicrousd(Math.round(n));

/** Each trail's spend and tokens as used of max. */
export function TrailBudgets({ trails, limit }: { trails: UsageSummary["byTrail"]; limit?: number }) {
  if (trails.length === 0) return <Empty title="No trail spent anything in this window" />;
  return (
    <div className="stack">
      {[...trails]
        .sort((a, b) => {
          const ratio = (t: typeof a) =>
            t.budget.spendMicrousdMax > 0
              ? t.budget.spendMicrousdUsed / t.budget.spendMicrousdMax
              : t.budget.spendMicrousdUsed > 0
                ? Infinity
                : 0;
          return ratio(b) - ratio(a);
        })
        .slice(0, limit)
        .map((t) => (
          <div key={t.trailId} className="stack-sm">
            <Meter
              label={
                <>
                  <a href={`#/inbox/${t.trailId}`} className="mono">
                    {t.short}
                  </a>{" "}
                  {t.title}
                </>
              }
              used={t.budget.spendMicrousdUsed}
              max={t.budget.spendMicrousdMax}
              unknown={t.totals.unknownCost}
              format={usd}
            />
            <Meter label="Tokens" used={t.budget.tokensUsed} max={t.budget.tokensMax} format={formatTokens} />
          </div>
        ))}
    </div>
  );
}
