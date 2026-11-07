import type { UsageSummary } from "@ephyra/core";
import { dayLabel, formatMicrousd } from "../lib/format.ts";
import { Table } from "../kit.ts";
import "./SpendChart.css";

const W = 640;
const H = 220;
const PAD = { top: 18, right: 8, bottom: 30, left: 44 };

function niceMax(v: number): number {
  if (v <= 0) return 1_000_000;
  const step = 10 ** Math.floor(Math.log10(v)) / 2;
  return Math.ceil(v / step) * step;
}

/**
 * Known spend per UTC day as bars. Days with unpriced work carry a marker with the count, because their real spend is
 * higher than the bar. A table with the same numbers follows for screen readers.
 */
export function SpendChart({ days }: { days: UsageSummary["byDay"] }) {
  const top = niceMax(Math.max(0, ...days.map((d) => d.totals.costMicrousd)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(1, days.length);
  const bar = Math.min(34, slot * 0.64);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const every = days.length > 10 ? 2 : 1;
  return (
    <figure className="spend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="spend-chart-title spend-chart-desc" preserveAspectRatio="xMidYMid meet">
        <title id="spend-chart-title">Known spend by day</title>
        <desc id="spend-chart-desc">{`Bars show known spend per day. A ring marks days with unpriced work.`}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="spend-chart-tick">{formatMicrousd(t).replace(".00", "")}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const h = (d.totals.costMicrousd / top) * plotH;
          return (
            <g key={d.key}>
              <rect x={cx - bar / 2} y={PAD.top + plotH - h} width={bar} height={Math.max(h, d.totals.costMicrousd > 0 ? 2 : 0)} rx={3} fill="var(--glow)">
                <title>{`${dayLabel(d.key)}: ${formatMicrousd(d.totals.costMicrousd)}${d.totals.unknownCost ? ` plus ${d.totals.unknownCost} unknown` : ""}`}</title>
              </rect>
              {d.totals.unknownCost > 0 && (
                <g>
                  <circle cx={cx} cy={Math.max(PAD.top - 2, y(d.totals.costMicrousd) - 9)} r={7} fill="none" stroke="var(--warn)" strokeWidth={2} />
                  <text x={cx} y={Math.max(PAD.top - 2, y(d.totals.costMicrousd) - 9) + 3.5} textAnchor="middle" className="spend-chart-unknown">{d.totals.unknownCost}</text>
                </g>
              )}
              {i % every === 0 && <text x={cx} y={H - 10} textAnchor="middle" className="spend-chart-tick">{dayLabel(d.key)}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="spend-chart-legend muted">Bars are known spend. A ring with a number is the count of unpriced entries that day.</figcaption>
      <div className="sr-only">
        <Table label="Known spend by day">
          <thead><tr><th>Day</th><th>Known spend</th><th>Unpriced entries</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.key}><td>{d.key}</td><td>{formatMicrousd(d.totals.costMicrousd)}</td><td>{d.totals.unknownCost}</td></tr>)}</tbody>
        </Table>
      </div>
    </figure>
  );
}
