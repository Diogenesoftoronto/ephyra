import { useEffect, useRef, useState } from "react";
import type { UsageForecast, UsageForecastCapability, UsageForecastInput } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { UnknownWriteOutcome, VoiceRequestError } from "../api.ts";
import { Button } from "../kit.ts";
import { dayLabel, formatMicrousd } from "../lib/format.ts";
import { lastCompleteDay } from "../lib/usage-charts.ts";
import { readForecastOperation, rememberForecastOperation, forgetForecastOperation } from "../lib/forecast-operation.ts";
import "./ForecastPanel.css";

export type ForecastState =
  | { kind: "idle" }
  | { kind: "pending"; op: string; input: UsageForecastInput }
  | { kind: "ready"; value: Extract<UsageForecast, { status: "ok" }>; op: string }
  | { kind: "insufficient"; value: Extract<UsageForecast, { status: "insufficient_history" }> }
  | { kind: "rate-limited"; message: string; retryAfterSeconds?: number }
  | { kind: "error"; message: string }
  /** The provider may have run and billed. The same key is used to check; nothing new is started until resolved. */
  | { kind: "unknown"; op: string; input: UsageForecastInput | null; message: string };

const opKey = () => `forecast-${crypto.randomUUID()}`;

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
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [state, setState] = useState<ForecastState>({ kind: "idle" });
  const [horizon, setHorizon] = useState(7);
  const abort = useRef<AbortController | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const asOf = lastCompleteDay(now);
  const input = { asOf, historyDays: 28, horizonDays: horizon };
  useEffect(() => {
    let live = true;
    setCapability("loading");
    api.forecastCapability().then((c) => live && setCapability(c), () => live && setCapability("error"));
    return () => { live = false; };
  }, [api, scope, capabilityRetry]);
  useEffect(() => {
    setState({ kind: "idle" });
    setHorizon(7);
    onForecast(null);
    // Preserve the operation key and original dates/horizon across navigation. No credentials or usage history is saved.
    try {
      const saved = readForecastOperation(sessionStorage, scope);
      if (saved) {
        if (saved.input) setHorizon(saved.input.horizonDays);
        setState({ kind: "unknown", ...saved, message: saved.input
          ? "An earlier forecast did not confirm. Check the original request before starting another."
          : "An earlier forecast has an unknown outcome, but its original dates and horizon were not saved. Check Usage; it cannot be safely retried here." });
      }
    } catch { /* storage blocked */ }
    return () => { abort.current?.abort(); };
  }, [api, scope]);
  const remember = (op: string | null, requestInput = input) => {
    try {
      if (op) rememberForecastOperation(sessionStorage, scope, { op, input: requestInput });
      else forgetForecastOperation(sessionStorage, scope);
    } catch { /* memory only */ }
  };
  const run = async (op: string, requestInput = input) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ kind: "pending", op, input: requestInput });
    remember(op, requestInput);
    try {
      const value = await api.forecast(requestInput, op, controller.signal);
      if (controller.signal.aborted) return;
      remember(null);
      if (value.status === "ok") { setState({ kind: "ready", value, op }); onForecast(value); }
      else { setState({ kind: "insufficient", value }); onForecast(null); }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof VoiceRequestError ? error.code : null;
      if (code === "reconciliation_required" || error instanceof UnknownWriteOutcome) {
        setState({ kind: "unknown", op, input: requestInput, message: error instanceof Error ? error.message : "The outcome is unknown." });
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
    setState({
      kind: "unknown",
      op: state.op,
      input: state.input,
      message: "You stopped waiting. The request was already sent and may still finish and be billed.",
    });
  };
  if (capability === "loading") return <p className="forecast-line muted" role="status">Checking whether forecasting is configured…</p>;
  if (capability === "error")
    return (
      <div className="forecast-line">
        <p className="muted">Forecast availability could not be read. Recorded spend above is unaffected.</p>
        <Button size="sm" onClick={() => setCapabilityRetry((n) => n + 1)}>
          Check availability again
        </Button>
      </div>
    );
  if (!capability.available) {
    return (
      <details className="forecast forecast--off">
        <summary><strong>Spend forecast</strong> <span className="muted">Not configured</span></summary>
        <p>{capability.reason}</p>
        <p className="muted">Recorded spend remains available. A forecast appears here when Clairic is connected.</p>
      </details>
    );
  }
  const busy = state.kind === "pending";
  const basisEnd = state.kind === "ready" ? state.value.basis.to
    : state.kind === "pending" || state.kind === "unknown" ? state.input?.asOf ?? asOf : asOf;
  return (
    <section className="forecast" aria-label="Spend forecast">
      <div className="forecast__head">
        <div>
          <h3>Spend forecast</h3>
          <p className="muted">
            Clairic via {capability.provider === "notorganic" ? "Not Organic" : "Cloudflare Workers AI"} · from 28
            complete UTC days ending {dayLabel(basisEnd)}. Runs only when you ask, and is metered like other model work.
          </p>
        </div>
        <div className="forecast__controls">
          <label>
            <span>Days ahead</span>
            <select
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value))}
              disabled={busy || state.kind === "unknown"}
            >
              {[7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          {busy ? (
            <Button onClick={cancel}>Stop waiting</Button>
          ) : state.kind === "unknown" ? (
            <Button
              variant="primary"
              disabled={!state.input}
              onClick={() => {
                if (state.input) void run(state.op, state.input);
              }}
            >
              Check saved forecast
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void run(opKey())}>
              {state.kind === "ready" ? "Forecast again" : "Forecast spend"}
            </Button>
          )}
        </div>
      </div>
      <div
        ref={status}
        tabIndex={-1}
        className="forecast__status"
        data-kind={state.kind}
        role={state.kind === "unknown" || state.kind === "error" ? "alert" : "status"}
      >
        {state.kind === "idle" && (
          <p className="muted">No forecast yet. Nothing is sent until you select Forecast spend.</p>
        )}
        {state.kind === "pending" && (
          <p>
            <span className="forecast__dot" aria-hidden="true" /> Asking Clairic… You can leave this page; the result is
            saved under this request.
          </p>
        )}
        {state.kind === "ready" && (
          <>
            <p>
              <strong>Forecast:</strong> daily medians add to{" "}
              {formatMicrousd(state.value.days.reduce((n, d) => n + d.median, 0))} over the next{" "}
              {state.value.days.length} days. Shown dashed on the chart.{" "}
              {state.value.days.every((d) => d.p10 !== null && d.p90 !== null)
                ? "The chart shows the provider's daily p10–p90 intervals."
                : "The provider returned no complete daily interval."}
            </p>
            <p className="muted">
              Model {state.value.engine} (requested {state.value.requestedModel})
              {state.value.pNull !== null ? ` · p(null) ${state.value.pNull.toFixed(2)}` : ""} · forecast cost{" "}
              {formatMicrousd(state.value.receipt.costMicrousd)}. Based on {state.value.basis.pricedEntries} priced
              entries; {state.value.basis.unknownCostEntries} with unknown cost are not in the forecast
              {state.value.basis.excludedPartialDay
                ? `; ${dayLabel(state.value.basis.excludedPartialDay)} is partial and excluded`
                : ""}
              . Budgets are unchanged.
            </p>
          </>
        )}
        {state.kind === "insufficient" && (
          <p>
            Not enough history to forecast: {state.value.basis.daysWithPricedSpend} of the last{" "}
            {state.value.basis.completeDays} complete days have priced spend; at least 3 are needed. Nothing was sent or
            billed.
          </p>
        )}
        {state.kind === "rate-limited" && (
          <p>
            <strong>The provider is busy.</strong>{" "}
            {state.retryAfterSeconds !== undefined
              ? `It asked to wait ${state.retryAfterSeconds} seconds.`
              : "It did not say for how long."}{" "}
            The request did not run. Try again later.
          </p>
        )}
        {state.kind === "error" && (
          <p>
            <strong>No forecast.</strong> {state.message} Recorded spend is unaffected.
          </p>
        )}
        {state.kind === "unknown" && (
          <>
            <p>
              <strong>Forecast not confirmed.</strong> {state.message}
            </p>
            <p className="muted">
              Check saved forecast asks with the same request key, so it cannot be billed twice.{" "}
              <a href="#/usage">The ledger</a> shows whether it was recorded.
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                remember(null);
                setState({ kind: "idle" });
              }}
            >
              Leave unresolved
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
