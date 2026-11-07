import type { ReactNode } from "react";
import type { UsageTotals } from "@ephyra/core";
import { Badge, Meter, Table } from "../kit.ts";
import { formatDuration, formatTokens } from "../lib/format.ts";
import { TotalCost } from "./Cost.tsx";
import "./BreakdownTable.css";

export type BreakdownRow = { key: string; label: ReactNode; totals: UsageTotals };

/** Spend grouped by persona, engine or anything else. Selecting a row filters the ledger below it. */
export function BreakdownTable({ title, rows, selected, onSelect }: {
  title: string; rows: BreakdownRow[]; selected?: string | null; onSelect?: (key: string | null) => void;
}) {
  const top = Math.max(1, ...rows.map((r) => r.totals.costMicrousd));
  return (
    <Table label={title}>
      <caption className="sr-only">{title}</caption>
      <thead><tr><th>{title}</th><th>Spend</th><th>Tokens</th><th>Time</th><th>Problems</th></tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={5} className="muted">No usage in this window.</td></tr>}
        {rows.map((r) => (
          <tr key={r.key} aria-selected={selected === r.key || undefined}>
            <td>
              {onSelect
                ? <button type="button" className="breakdown-pick" aria-pressed={selected === r.key} onClick={() => onSelect(selected === r.key ? null : r.key)}>{r.label}</button>
                : r.label}
            </td>
            <td className="breakdown-spend"><TotalCost totals={r.totals} /><Meter label={`${title} share`} used={r.totals.costMicrousd} max={top} /></td>
            <td className="num">{formatTokens(r.totals.tokens)}</td>
            <td className="num">{formatDuration(r.totals.wallMs)}</td>
            <td>
              {r.totals.failed > 0 && <Badge tone="bad">{r.totals.failed} failed</Badge>}{" "}
              {r.totals.unavailable > 0 && <Badge tone="warn">{r.totals.unavailable} unavailable</Badge>}
              {r.totals.failed + r.totals.unavailable === 0 && <span className="muted">none</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
