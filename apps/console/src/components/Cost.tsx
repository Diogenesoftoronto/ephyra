import type { UsageTotals } from "@ephyra/core";
import { Badge } from "../kit.ts";
import { formatMicrousd, UNKNOWN } from "../lib/format.ts";

/** A cost that may be unknown. Unknown reads "unknown", never $0. */
export function Cost({ micro }: { micro: number | null | undefined }) {
  if (micro === null || micro === undefined)
    return (
      <span className="muted" title="This cost could not be priced">
        {UNKNOWN}
      </span>
    );
  return <span className="num">{formatMicrousd(micro)}</span>;
}

/** A total of known costs, with the count of rows that could not be priced shown beside it. */
export function TotalCost({ totals }: { totals: Pick<UsageTotals, "costMicrousd" | "unknownCost"> }) {
  const { costMicrousd, unknownCost } = totals;
  return (
    <span className="num">
      {unknownCost > 0 && costMicrousd === 0 ? UNKNOWN : formatMicrousd(costMicrousd)}
      {unknownCost > 0 && (
        <>
          {" "}
          <Badge tone="warn">{unknownCost} unknown</Badge>
        </>
      )}
    </span>
  );
}
