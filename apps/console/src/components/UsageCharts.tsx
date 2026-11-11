import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { UsageForecast, UsageSummary } from "@ephyra/core";
import { dayLabel, formatMicrousd } from "../lib/format.ts";
import { coverage, drivers, forecastDaily, outcomes, paceSeries, type Driver } from "../lib/usage-charts.ts";
import { DataTable } from "./DataTable.tsx";
import "./UsageCharts.css";

const usd = (micro: number) => {
  const n = micro / 1e6;
  return n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`;
};
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((s) => s >= v) ?? 10 * p);
}
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const o = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(260, e.contentRect.width)); });
    o.observe(ref.current);
    return () => o.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Keyboard reading of a series: arrows move through points, Home/End jump, Escape clears. */
function useCursor(length: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const i = active ?? length - 1;
    const next = e.key === "ArrowRight" ? Math.min(length - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? length - 1 : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };
  return { active, setActive, onKeyDown };
}

/**
 * Spending pace: recorded daily spend as bars and the running total as a line, with today's partial day marked and an
 * optional daily Clairic forecast drawn dashed with its p10–p90 band. Recorded and forecast values are never summed.
 */
export function SpendPace({ days, today, forecast, actions }: {
  days: UsageSummary["byDay"];
  today: string;
  forecast?: Extract<UsageForecast, { status: "ok" }> | null;
  actions?: ReactNode;
}) {
  const [host, width] = useWidth<HTMLDivElement>();
  const pace = paceSeries(days, today);
  const ahead = forecast ? forecastDaily(forecast) : [];
  const slots = [...new Set([...pace.map((p) => p.day), ...ahead.map((p) => p.day)])].sort();
  const cursor = useCursor(slots.length);
  const H = width < 420 ? 200 : 230, left = 52, right = 12, top = 16, bottom = 28;
  const maxY = niceCeil(Math.max(1, ...pace.map((p) => p.cumulative), ...ahead.map((p) => p.high ?? p.median)));
  const step = (width - left - right) / Math.max(1, slots.length);
  const x = (i: number) => left + step * i + step / 2;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / maxY);
  const xi = (day: string) => slots.indexOf(day);
  const ticks = [0, maxY / 2, maxY];
  const labelEvery = Math.max(1, Math.ceil((slots.length * 44) / (width - left)));
  const line = pace.map((p, i) => `${i ? "L" : "M"}${x(xi(p.day))},${y(p.cumulative)}`).join("");
  const fLine = ahead.map((p, i) => `${i ? "L" : "M"}${x(xi(p.day))},${y(p.median)}`).join("");
  const band = ahead.every((p) => p.low !== null && p.high !== null) && ahead.length
    ? ahead.map((p, i) => `${i ? "L" : "M"}${x(xi(p.day))},${y(p.high!)}`).join("")
      + [...ahead].reverse().map((p) => `L${x(xi(p.day))},${y(p.low!)}`).join("") + "Z"
    : null;
  const unknown = pace.reduce((n, p) => n + p.unknown, 0);
  const a = cursor.active;
  const activeDay = a === null ? null : slots[a]!;
  const actual = activeDay ? pace.find((p) => p.day === activeDay) : undefined;
  const predicted = activeDay ? ahead.find((p) => p.day === activeDay) : undefined;
  const barW = Math.max(3, Math.min(22, step * 0.5));
  return (
    <div className="usage-chart" ref={host}>
      <div className="usage-chart__legend" aria-hidden="true">
        <span>
          <i className="sw sw--bar" /> Recorded per day
        </span>
        <span>
          <i className="sw sw--line" /> Running total
        </span>
        {forecast && (
          <span>
            <i className="sw sw--forecast" /> Forecast per day (median, p10–p90)
          </span>
        )}
        <span>
          <i className="sw sw--partial" /> Today so far
        </span>
        {actions}
      </div>
      <div className="usage-chart__plot">
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={
            `Recorded spend pace, ${pace.length} days, ${formatMicrousd(pace.at(-1)?.cumulative ?? 0)} in total` +
            (forecast ? `, with a forecast for ${forecast.days.length} days` : "") + ". Use arrow keys to read each day."
          }
          onKeyDown={cursor.onKeyDown}
          onBlur={() => cursor.setActive(null)}
          onPointerLeave={() => cursor.setActive(null)}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.floor((e.clientX - r.left - left) / step);
            cursor.setActive(i >= 0 && i < slots.length ? i : null);
          }}
        >
          <g className="grid">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} />
                <text x={left - 8} y={y(t) + 4} textAnchor="end">
                  {usd(t)}
                </text>
              </g>
            ))}
          </g>
          {pace.map((p, i) => (
            <rect
              key={p.day}
              className={p.partial ? "bar bar--partial" : "bar"}
              x={x(xi(p.day)) - barW / 2}
              y={y(p.daily)}
              width={barW}
              height={Math.max(0, y(0) - y(p.daily))}
              rx={Math.min(4, barW / 2)}
            />
          ))}
          {band && <path className="band" d={band} />}
          <path className="pace" d={line} />
          {forecast && <path className="forecast" d={fLine} />}
          {ahead.map((p) => (
            <circle key={p.day} className="dot dot--forecast" cx={x(xi(p.day))} cy={y(p.median)} r={3} />
          ))}
          {pace.map((p) => (
            <circle
              key={p.day}
              className={p.partial ? "dot dot--partial" : "dot"}
              cx={x(xi(p.day))}
              cy={y(p.cumulative)}
              r={p.partial ? 4 : 3}
            />
          ))}
          {a !== null && <line className="cursor" x1={x(a)} x2={x(a)} y1={top} y2={H - bottom} />}
          <g className="days">
            {slots.map(
              (d, i) =>
                (i % labelEvery === 0 || i === slots.length - 1) && (
                  <text key={d} x={x(i)} y={H - 8} textAnchor="middle">
                    {d === today ? "Today" : dayLabel(d)}
                  </text>
                ),
            )}
          </g>
        </svg>
        {activeDay && (
          <div
            className="usage-chart__tip"
            role="status"
            style={{ left: Math.min(Math.max(8, x(a!) - 90), width - 188) }}
          >
            <strong>
              {dayLabel(activeDay)}
              {activeDay === today ? " · today so far" : ""}
            </strong>
            {actual && (
              <span>
                Recorded {formatMicrousd(actual.daily)} · total {formatMicrousd(actual.cumulative)}
              </span>
            )}
            {actual && actual.unknown > 0 && <span>{actual.unknown} with unknown cost (not drawn)</span>}
            {predicted && (
              <span>
                Forecast for this day {formatMicrousd(predicted.median)}
                {predicted.low !== null && predicted.high !== null
                  ? ` (${formatMicrousd(predicted.low)}–${formatMicrousd(predicted.high)})`
                  : " · no interval returned"}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="ui-label">
        UTC days. Today is partial.{" "}
        {unknown > 0
          ? `${unknown} entries have unknown cost and are counted, not drawn.`
          : "Every entry here has a recorded cost."}
        {forecast
          ? " Forecast ranges apply to individual days, exclude unknown costs, and do not change any budget."
          : ""}
      </p>
      <details className="ui-chart-data">
        <summary>View daily amounts</summary>
        <DataTable label="Recorded spend by day">
          <thead>
            <tr>
              <th>Day</th>
              <th>Recorded</th>
              <th>Running total</th>
              <th>Unknown cost</th>
              {forecast && <th>Daily forecast (p10–p90)</th>}
            </tr>
          </thead>
          <tbody>
            {slots.map((d) => {
              const p = pace.find((q) => q.day === d);
              const f = ahead.find((q) => q.day === d);
              return (
                <tr key={d}>
                  <td>
                    {dayLabel(d)}
                    {d === today ? " (so far)" : ""}
                  </td>
                  <td>{p ? formatMicrousd(p.daily) : "—"}</td>
                  <td>{p ? formatMicrousd(p.cumulative) : "—"}</td>
                  <td>{p ? p.unknown : "—"}</td>
                  {forecast && (
                    <td>
                      {f
                        ? `${formatMicrousd(f.median)}${f.low !== null && f.high !== null ? ` (${formatMicrousd(f.low)}–${formatMicrousd(f.high)})` : ""}`
                        : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </details>
    </div>
  );
}

/** What drove recorded cost, as a ranked bar list. Selecting a row filters the ledger, like the breakdown tables. */
export function CostDrivers({ groups, title, render, selected, onSelect }: {
  groups: readonly { key: string | null; totals: UsageSummary["totals"] }[];
  title: string;
  render?: (key: string) => ReactNode;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const { top, rest } = drivers(groups);
  const rows: (Driver & { other?: boolean })[] = [...top, ...(rest ? [{ ...rest, other: true }] : [])];
  if (!rows.length) return <p className="muted">Nothing recorded in this window.</p>;
  const max = Math.max(...rows.map((r) => r.cost), 1);
  return (
    <ol className="drivers" aria-label={`Cost by ${title.toLowerCase()}, largest first`}>
      {rows.map((r) => {
        const content = (
          <>
            <span className="drivers__name">{r.other ? r.key : render ? render(r.key) : r.key}</span>
            <span className="drivers__track" aria-hidden="true"><span style={{ width: `${(100 * r.cost) / max}%` }} /></span>
            <span className="drivers__value">
              {formatMicrousd(r.cost)} <span className="muted">{Math.round(r.share * 100)}%</span>
              {r.unknown > 0 && <span className="drivers__unknown"> + {r.unknown} unknown</span>}
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {onSelect && !r.other ? (
              <button type="button" className="drivers__row" aria-pressed={selected === r.key}
                onClick={() => onSelect(selected === r.key ? null : r.key)}>{content}</button>
            ) : <div className="drivers__row">{content}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** Outcomes per day (ok, failed, unavailable) and how much of the work had a recorded price. */
export function OutcomesCoverage({ days, totals, today }: { days: UsageSummary["byDay"]; totals: UsageSummary["totals"]; today: string }) {
  const [host, width] = useWidth<HTMLDivElement>();
  const rows = outcomes(days, today);
  const cov = coverage(totals);
  const cursor = useCursor(rows.length);
  const H = 120, left = 8, right = 8, top = 8, bottom = 22;
  const max = Math.max(1, ...rows.map((r) => r.ok + r.failed + r.unavailable));
  const step = (width - left - right) / Math.max(1, rows.length);
  const bw = Math.max(4, Math.min(24, step * 0.6));
  const h = (n: number) => ((H - top - bottom) * n) / max;
  const labelEvery = Math.max(1, Math.ceil((rows.length * 44) / width));
  const a = cursor.active;
  return (
    <div className="usage-chart" ref={host}>
      <div className="coverage">
        <div>
          <span className="coverage__value">{cov === null ? "—" : `${Math.round(cov * 100)}%`}</span>
          <span className="coverage__label">of {totals.entries} entries have a recorded price</span>
        </div>
        <div
          className="coverage__bar"
          role="img"
          aria-label={
            cov === null
              ? "No entries"
              : `${totals.entries - totals.unknownCost} priced, ${totals.unknownCost} unknown cost`
          }
        >
          <span className="coverage__priced" style={{ flexGrow: totals.entries - totals.unknownCost }} />
          <span className="coverage__unknown" style={{ flexGrow: totals.unknownCost }} />
        </div>
      </div>
      <div className="usage-chart__legend" aria-hidden="true">
        <span>
          <i className="sw sw--ok" /> Finished
        </span>
        <span>
          <i className="sw sw--failed" /> Failed
        </span>
        <span>
          <i className="sw sw--unavailable" /> Unavailable
        </span>
      </div>
      <div className="usage-chart__plot">
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`Outcomes per day: ${totals.failed} failed and ${totals.unavailable} unavailable of ${totals.entries}. Use arrow keys to read each day.`}
          onKeyDown={cursor.onKeyDown}
          onBlur={() => cursor.setActive(null)}
          onPointerLeave={() => cursor.setActive(null)}
          onPointerMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.floor((e.clientX - r.left - left) / step);
            cursor.setActive(i >= 0 && i < rows.length ? i : null);
          }}
        >
          {rows.map((r, i) => {
            const cx = left + step * i + step / 2 - bw / 2;
            let base = H - bottom;
            const seg = (n: number, cls: string) => {
              if (!n) return null;
              const height = h(n);
              base -= height;
              return (
                <rect
                  key={cls}
                  className={cls}
                  x={cx}
                  y={base + 1}
                  width={bw}
                  height={Math.max(0, height - 2)}
                  rx={2}
                />
              );
            };
            return (
              <g key={r.day} className={r.partial ? "partial" : undefined} data-active={a === i ? "" : undefined}>
                {seg(r.ok, "seg seg--ok")}
                {seg(r.failed, "seg seg--failed")}
                {seg(r.unavailable, "seg seg--unavailable")}
              </g>
            );
          })}
          <g className="days">
            {rows.map(
              (r, i) =>
                (i % labelEvery === 0 || i === rows.length - 1) && (
                  <text key={r.day} x={left + step * i + step / 2} y={H - 6} textAnchor="middle">
                    {r.day === today ? "Today" : dayLabel(r.day)}
                  </text>
                ),
            )}
          </g>
        </svg>
        {a !== null && rows[a] && (
          <div
            className="usage-chart__tip"
            role="status"
            style={{ left: Math.min(Math.max(8, left + step * a - 80), width - 188) }}
          >
            <strong>
              {dayLabel(rows[a].day)}
              {rows[a].partial ? " · so far" : ""}
            </strong>
            <span>
              {rows[a].ok} finished · {rows[a].failed} failed · {rows[a].unavailable} unavailable
            </span>
            <span>
              {rows[a].priced} priced · {rows[a].unknown} unknown cost
            </span>
          </div>
        )}
      </div>
      <details className="ui-chart-data">
        <summary>View outcomes by day</summary>
        <DataTable label="Outcomes and cost coverage by day">
          <thead>
            <tr>
              <th>Day</th>
              <th>Finished</th>
              <th>Failed</th>
              <th>Unavailable</th>
              <th>Unknown cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day}>
                <td>
                  {dayLabel(r.day)}
                  {r.partial ? " (so far)" : ""}
                </td>
                <td>{r.ok}</td>
                <td>{r.failed}</td>
                <td>{r.unavailable}</td>
                <td>{r.unknown}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </details>
    </div>
  );
}
