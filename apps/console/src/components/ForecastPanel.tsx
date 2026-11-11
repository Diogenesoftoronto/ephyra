import { useEffect, useRef, useState } from "react";
import type { UsageForecast, UsageForecastCapability } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { UnknownWriteOutcome, VoiceRequestError } from "../api.ts";
import { Button } from "../kit.ts";
import { dayLabel, formatMicrousd } from "../lib/format.ts";
import { lastCompleteDay } from "../lib/usage-charts.ts";
import "./ForecastPanel.css";

export type ForecastState =
  | { kind: "idle" }
  | { kind: "pending"; op: string }
  | { kind: "ready"; value: Extract<UsageForecast, { status: "ok" }>; op: string }
  | { kind: "insufficient"; value: Extract<UsageForecast, { status: "insufficient_history" }> }
  | { kind: "rate-limited"; message: string; retryAfterSeconds?: number }
  | { kind: "error"; message: string }
  /** The provider may have run and billed. The same key is used to check; nothing new is started until resolved. */
  | { kind: "unknown"; op: string; message: string };

const opKey = () => `forecast-${crypto.randomUUID()}`;
const KEY = "ephyra.forecast-op";

/**
 * On-demand spend forecast through the configured Clairic route. Nothing runs on page load; the button is the only
 * thing that can spend. Results are labelled as forecasts with the provider's own model identity.
 */
export function ForecastPanel({ now, scope, onForecast }: {
  now: number;
  /** Account/workspace. A different scope never shows another scope's forecast or pending key. */
  scope: string;
  onForecast: (value: Extract<UsageForecast, { status: "ok" }> | null) => void;
}) {
  const api = useApi();
  const [capability, setCapability] = useState<UsageForecastCapability | "loading" | "error">("loading");
  const [state, setState] = useState<ForecastState>({ kind: "idle" });
  const [horizon, setHorizon] = useState(7);
  const abort = useRef<AbortController | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const asOf = lastCompleteDay(now);
  const input = { asOf, historyDays: 28, horizonDays: horizon };
  useEffect(() => {
    let live = true;
    api.forecastCapability().then((c) => live && setCapability(c), () => live && setCapability("error"));
    // An unresolved operation survives navigation in this tab (key only, no data), so it can be checked, not re-run.
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { scope: string; op: string } | null;
      if (saved?.scope === scope) setState({ kind: "unknown", op: saved.op, message: "An earlier forecast did not confirm. Check it before starting another." });
    } catch { /* storage blocked */ }
    return () => { live = false; abort.current?.abort(); };
  }, [api, scope]);
  const remember = (op: string | null) => {
    try { if (op) sessionStorage.setItem(KEY, JSON.stringify({ scope, op })); else sessionStorage.removeItem(KEY); } catch { /* memory only */ }
  };
  const run = async (op: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: "pending", op });
    remember(op);
    try {
      const value = await api.forecast(input, op, controller.signal);
      if (controller.signal.aborted) return;
      remember(null);
      if (value.status === "ok") { setState({ kind: "ready", value, op }); onForecast(value); }
      else { setState({ kind: "insufficient", value }); onForecast(null); }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof VoiceRequestError ? error.code : null;
      if (code === "reconciliation_required" || error instanceof UnknownWriteOutcome) {
        setState({ kind: "unknown", op, message: error instanceof Error ? error.message : "The outcome is unknown." });
      } else {
        remember(null);
        if (code === "rate_limited") setState({ kind: "rate-limited", message: error instanceof Error ? error.message : "Rate limited.",
          ...(error instanceof VoiceRequestError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
        else setState({ kind: "error", message: error instanceof Error ? error.message : "The forecast could not be read." });
      }
      onForecast(null);
    }
    requestAnimationFrame(() => status.current?.focus({ preventScroll: false }));
  };
  const cancel = () => {
    if (state.kind !== "pending") return;
    abort.current?.abort();
    setState({ kind: "unknown", op: state.op, message: "You stopped waiting. The request was already sent and may still finish and be billed." });
  };
  if (capability === "loading") return <p className="forecast-line muted" role="status">Checking whether forecasting is configured…</p>;
  if (capability === "error") return <p className="forecast-line muted">Forecast availability could not be read. Recorded spend above is unaffected.</p>;
  if (!capability.available) {
    return (
      <details className="forecast forecast--off">
        <summary><strong>Spend forecast</strong> <span className="muted">Not configured</span></summary>
        <p>{capability.reason}</p>
        <p className="muted">Ephyra does not draw an average and call it a forecast. Recorded spend above is complete without it.</p>
      </details>
    );
  }
  const busy = state.kind === "pending";
  return (
    <section className="forecast" aria-label="Spend forecast">
      <div className="forecast__head">
        <div>
          <h3>Spend forecast</h3>
          <p className="muted">
            Clairic via {capability.provider === "notorganic" ? "Not Organic" : "Cloudflare Workers AI"} · from 28 complete UTC days ending {dayLabel(asOf)}.
            Runs only when you ask, and is metered like other model work.
          </p>
        </div>
        <div className="forecast__controls">
          <label>
            <span>Days ahead</span>
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} disabled={busy || state.kind === "unknown"}>
              {[7, 14, 30].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          {busy ? (
            <Button onClick={cancel}>Stop waiting</Button>
          ) : state.kind === "unknown" ? (
            <Button variant="primary" onClick={() => void run(state.op)}>Check saved forecast</Button>
          ) : (
            <Button variant="primary" onClick={() => void run(opKey())}>
              {state.kind === "ready" ? "Forecast again" : "Forecast spend"}
            </Button>
          )}
        </div>
      </div>
      <div ref={status} tabIndex={-1} className="forecast__status" data-kind={state.kind} role={state.kind === "unknown" || state.kind === "error" ? "alert" : "status"}>
        {state.kind === "idle" && <p className="muted">No forecast yet. Nothing is sent until you select Forecast spend.</p>}
        {state.kind === "pending" && <p><span className="forecast__dot" aria-hidden="true" /> Asking Clairic… You can leave this page; the result is saved under this request.</p>}
        {state.kind === "ready" && (
          <>
            <p>
              <strong>Forecast, not recorded spend:</strong> about {formatMicrousd(state.value.days.reduce((n, d) => n + d.median, 0))} over the next {state.value.days.length} days
              {state.value.days.every((d) => d.p10 !== null && d.p90 !== null)
                ? ` (p10–p90 ${formatMicrousd(state.value.days.reduce((n, d) => n + d.p10!, 0))}–${formatMicrousd(state.value.days.reduce((n, d) => n + d.p90!, 0))})`
                : "; the provider returned no interval"}. Shown dashed on the chart.
            </p>
            <p className="muted">
              Model {state.value.engine} (requested {state.value.requestedModel}){state.value.pNull !== null ? ` · p(null) ${state.value.pNull.toFixed(2)}` : ""} ·
              forecast cost {formatMicrousd(state.value.receipt.costMicrousd)}. Based on {state.value.basis.pricedEntries} priced entries;
              {" "}{state.value.basis.unknownCostEntries} with unknown cost are not in the forecast{state.value.basis.excludedPartialDay ? `; ${dayLabel(state.value.basis.excludedPartialDay)} is partial and excluded` : ""}.
              Budgets are unchanged.
            </p>
          </>
        )}
        {state.kind === "insufficient" && (
          <p>Not enough history to forecast: {state.value.basis.daysWithPricedSpend} of the last {state.value.basis.completeDays} complete days have priced spend; at least 3 are needed. Nothing was sent or billed.</p>
        )}
        {state.kind === "rate-limited" && (
          <p><strong>The provider is busy.</strong> {state.retryAfterSeconds !== undefined ? `It asked to wait ${state.retryAfterSeconds} seconds.` : "It did not say for how long."} The request did not run. Try again later.</p>
        )}
        {state.kind === "error" && <p><strong>No forecast.</strong> {state.message} Recorded spend is unaffected.</p>}
        {state.kind === "unknown" && (
          <>
            <p><strong>Forecast not confirmed.</strong> {state.message}</p>
            <p className="muted">Check saved forecast asks with the same request key, so it cannot be billed twice. <a href="#/usage">The ledger</a> shows whether it was recorded.</p>
            <Button size="sm" variant="ghost" onClick={() => { remember(null); setState({ kind: "idle" }); }}>Leave unresolved</Button>
          </>
        )}
      </div>
    </section>
  );
}
