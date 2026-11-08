import type { UsageSummary } from "@ephyra/core";
import { BarChart, Empty } from "../kit.ts";
import { dayLabel, formatMicrousd } from "../lib/format.ts";
import { DataTable } from "./DataTable.tsx";

const usd = (n: number) => `$${n % 1 ? n.toFixed(1) : n}`;
const weekday = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { weekday: "short", timeZone: "UTC" });

/**
 * Recorded spend per UTC day. Only recorded costs are drawn; the entries with unknown cost are counted underneath, and a
 * table with every number follows for screen readers. The last bar is today so far.
 */
export function SpendByDay({ days, partial = true }: { days: UsageSummary["byDay"]; partial?: boolean }) {
  if (days.length === 0) return <Empty title="No spend recorded in this window" />;
  const unknown = days.reduce((n, d) => n + d.totals.unknownCost, 0);
  const seven = days.length <= 7;
  const data = days.map((d, i) => ({
    key: d.key,
    value: d.totals.costMicrousd / 1_000_000,
    label:
      i === days.length - 1 && partial ? "Today" : seven ? weekday(d.key) : String(Number(d.key.slice(8))),
  }));
  return (
    <div className="stack-sm">
      <BarChart
        label={`Recorded spend per day, last ${days.length} days`}
        format={usd}
        partial={partial}
        data={data}
      />
      <p className="ui-label">
        {partial ? "Today is the day so far. " : ""}
        {unknown > 0
          ? `${unknown} entries in this window have unknown cost and are not drawn.`
          : "Every entry in this window has a recorded cost."}
      </p>
      <details className="ui-chart-data">
        <summary>View daily amounts</summary>
        <DataTable label="Recorded spend by day">
          <thead>
            <tr>
              <th>Day</th>
              <th>Recorded spend</th>
              <th>Entries with unknown cost</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.key}>
                <td>{dayLabel(d.key)}</td>
                <td>{formatMicrousd(d.totals.costMicrousd)}</td>
                <td>{d.totals.unknownCost}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </details>
    </div>
  );
}
