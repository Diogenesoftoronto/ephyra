import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { formatMicrousd } from "../lib/format.ts";
import { costTrend, MIN_TREND_POINTS, type WeekCost } from "../lib/quest-cost.ts";
import { DataTable } from "./DataTable.tsx";
import "./QuestCost.css";

const short = (micro: number) => {
  const n = micro / 1e6;
  return n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`;
};
const deadEnds = (n: number) => `${n} dead ${n === 1 ? "end" : "ends"}`;
const weekLabel = (w: string) => new Date(`${w}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const o = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(280, e.contentRect.width)); });
    o.observe(ref.current);
    return () => o.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The headline: what one landed fix costs, week by week, and which way it is going. Bars are landings per week; the
 * line is cost per landed quest, with dead-end spend charged to the landings. Weeks without a landing leave a gap.
 */
export function QuestCost({ weeks }: { weeks: WeekCost[] }) {
  const [host, width] = useWidth();
  const reduced = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const trend = costTrend(weeks);
  const H = width < 480 ? 190 : 220, left = 8, right = 8, top = 18, bottom = 26;
  const step = (width - left - right) / weeks.length;
  const x = (i: number) => left + step * i + step / 2;
  const maxCost = Math.max(1, ...weeks.map((w) => w.perLanded ?? 0)) * 1.15;
  const maxLanded = Math.max(1, ...weeks.map((w) => w.landed));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / maxCost);
  const barH = (n: number) => ((H - top - bottom) * 0.42 * n) / maxLanded;
  const segments: string[] = [];
  let open = "";
  weeks.forEach((w, i) => {
    if (w.perLanded === null) { if (open) segments.push(open); open = ""; return; }
    open += `${open ? "L" : "M"}${x(i)},${y(w.perLanded)}`;
  });
  if (open) segments.push(open);
  const a = active === null ? null : weeks[active]!;
  /** Ticks are laid out from the latest week back, so the newest label is never crowded out. */
  const every = Math.max(1, Math.ceil((weeks.length * 52) / width));
  const valued = weeks.map((w, i) => ({ w, i })).filter((p) => p.w.perLanded !== null);
  const ends = valued.length > 1 ? [valued[0]!, valued.at(-1)!] : valued;
  const pct = trend.change === null ? null : Math.round(Math.abs(trend.change) * 100);
  const headline = trend.direction === "down" ? `${pct}% cheaper per landed fix`
    : trend.direction === "up" ? `${pct}% more per landed fix`
    : trend.direction === "flat" ? "Holding steady per landed fix"
    : trend.points === 0 ? "No landed quests yet" : "Not enough landings for a trend yet";
  const sub = trend.direction === "down" ? "Ephyra is landing more for less."
    : trend.direction === "up" ? "Each landing is costing more. Check the cost drivers below."
    : trend.direction === "unknown" && trend.points > 0
      ? `A trend needs landings in ${MIN_TREND_POINTS} different weeks; there are ${trend.points}.`
      : trend.points === 0 ? "Cost per quest appears once a quest lands with a receipt." : "Within 5% across the period.";

  return (
    <div className="qcost" ref={host}>
      <div className="qcost__head">
        <div>
          <p className="qcost__headline" data-direction={trend.direction}>
            {trend.direction === "down" && <span aria-hidden="true">↓ </span>}
            {trend.direction === "up" && <span aria-hidden="true">↑ </span>}
            {headline}
          </p>
          <p className="qcost__sub">{sub}</p>
        </div>
        <dl className="qcost__figures">
          <div><dt>Latest week</dt><dd>{trend.latest === null ? "—" : formatMicrousd(trend.latest)}</dd></div>
          <div><dt>12-week average</dt><dd>{trend.overall === null ? "—" : formatMicrousd(trend.overall)}</dd></div>
          <div><dt>Landed</dt><dd>{trend.landed}</dd></div>
        </dl>
      </div>
      {trend.points > 0 && (
        <div className="qcost__plot">
          <svg viewBox={`0 0 ${width} ${H}`} height={H} role="img" tabIndex={0}
            aria-label={`Cost per landed quest by week. ${headline}.`}
            onKeyDown={(e) => {
              const i = active ?? weeks.length;
              const next = e.key === "ArrowRight" ? Math.min(weeks.length - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1)
                : e.key === "Escape" ? null : undefined;
              if (next === undefined) return;
              e.preventDefault();
              setActive(next);
            }}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setActive(Math.min(weeks.length - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * weeks.length))));
            }}
            onPointerLeave={() => setActive(null)}>
            {weeks.map((w, i) => (
              <motion.rect key={w.week} className="qcost__bar" data-active={active === i ? "" : undefined}
                x={x(i) - Math.min(14, step * 0.3)} width={Math.min(28, step * 0.6)} rx={3}
                initial={reduced ? false : { height: 0, y: H - bottom }}
                animate={{ height: barH(w.landed), y: H - bottom - barH(w.landed) }}
                transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 26, delay: i * 0.025 }} />
            ))}
            {segments.map((d, i) => (
              <motion.path key={i} className="qcost__line" d={d}
                initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
                transition={reduced ? { duration: 0 } : { duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.15 }} />
            ))}
            {weeks.map((w, i) => w.perLanded === null ? null : (
              <circle key={w.week} className="qcost__dot" data-active={active === i ? "" : undefined} cx={x(i)} cy={y(w.perLanded)}
                r={active === i ? 5 : 3.5} />
            ))}
            {weeks.map((w, i) => (weeks.length - 1 - i) % every === 0 && (
              <text key={w.week} className="qcost__tick" x={x(i)} y={H - 8} textAnchor="middle">{weekLabel(w.week)}</text>
            ))}
            {active === null && ends.map(({ w, i }, k) => (
              <text key={`end-${w.week}`} className="qcost__value" x={x(i)} y={y(w.perLanded!) - 10}
                textAnchor={k === 0 && ends.length > 1 ? "start" : "end"} dx={k === 0 && ends.length > 1 ? -6 : 6}>
                {short(w.perLanded!)}
              </text>
            ))}
            {active !== null && <line className="qcost__cursor" x1={x(active)} x2={x(active)} y1={top} y2={H - bottom} />}
          </svg>
          {a && (
            <div className="qcost__tip" role="status" style={{ left: Math.min(width - 190, Math.max(0, x(active!) - 95)) }}>
              <strong>Week of {weekLabel(a.week)}</strong>
              <span>{a.perLanded === null ? "Nothing landed" : `${formatMicrousd(a.perLanded)} per landed quest`}</span>
              <span className="muted">{a.landed} landed{a.deadEnds ? ` · ${deadEnds(a.deadEnds)} (${short(a.deadEndSpend)})` : ""}</span>
            </div>
          )}
          <div className="qcost__legend" aria-hidden="true">
            <span><i className="qcost__sw qcost__sw--line" />Cost per landed quest</span>
            <span><i className="qcost__sw qcost__sw--bar" />Quests landed</span>
          </div>
        </div>
      )}
      <details className="qcost__table">
        <summary>Show as a table</summary>
        <DataTable label="Cost per landed quest by week">
          <thead><tr><th scope="col">Week</th><th scope="col">Landed</th><th scope="col">Dead ends</th>
            <th scope="col">Spend</th><th scope="col">Per landed quest</th></tr></thead>
          <tbody>{weeks.map((w) => <tr key={w.week}>
            <th scope="row">{weekLabel(w.week)}</th><td>{w.landed}</td><td>{w.deadEnds}</td>
            <td>{formatMicrousd(w.landedSpend + w.deadEndSpend)}</td><td>{w.perLanded === null ? "—" : formatMicrousd(w.perLanded)}</td>
          </tr>)}</tbody>
        </DataTable>
      </details>
      <p className="qcost__note">Counted from each quest's recorded budget spend. A quest counts as landed only with a landing
        receipt. Dead-end spend is charged to that week's landings, so dropping failures never makes the number look better.</p>
    </div>
  );
}
