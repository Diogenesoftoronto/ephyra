// On-demand spend forecast through a verified Clairic route. The history is the recorded ledger for complete UTC days
// only; today's partial day is excluded. A forecast is never recorded spend and never changes a budget.
import {
  canonicalJson, forecastPoints, ReconciliationRequired, sha256Hex, UsageForecast, type ForecastBackend,
  type OperationLedger, type UsageEntry, type UsageForecastBasis, type UsageForecastCapability, type UsageForecastInput,
} from "@ephyra/core";
import { HttpError, UnexpectedIdentity } from "@ephyra/models";
import { DAY_MS, type BilledTo, type UsageRecorder } from "./usage.ts";

export const MIN_COMPLETE_DAYS = 7;
const MIN_PRICED_DAYS = 3;
const FIELD = "daily_spend_usd";

export class ForecastError extends Error {
  constructor(readonly status: 400 | 409 | 429 | 502 | 503, message: string, readonly code: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export type ForecastRoute = { backend: ForecastBackend; provider: "notorganic" | "byok:cloudflare"; billedTo: BilledTo };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The bounded basis and the per-day history, oldest first. Pure: exported for property tests. */
export function forecastBasis(entries: readonly UsageEntry[], input: UsageForecastInput, now: Date) {
  const today = day(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  const end = Date.parse(`${input.asOf}T00:00:00Z`);
  const from = end - (input.historyDays - 1) * DAY_MS;
  const days: { day: string; spend: number; priced: number; unknown: number; failed: number }[] = [];
  for (let t = from; t <= end; t += DAY_MS) days.push({ day: day(t), spend: 0, priced: 0, unknown: 0, failed: 0 });
  const index = new Map(days.map((d, i) => [d.day, i]));
  for (const e of entries) {
    const i = index.get(e.at.slice(0, 10));
    if (i === undefined) continue;
    const d = days[i]!;
    if (e.outcome === "failed") d.failed++;
    if (e.costMicrousd === null) d.unknown++;
    else { d.spend += e.costMicrousd; d.priced++; }
  }
  const basis: UsageForecastBasis = {
    from: days[0]!.day, to: days.at(-1)!.day, completeDays: days.length,
    daysWithPricedSpend: days.filter((d) => d.priced > 0).length,
    pricedEntries: days.reduce((n, d) => n + d.priced, 0),
    unknownCostEntries: days.reduce((n, d) => n + d.unknown, 0),
    failedEntries: days.reduce((n, d) => n + d.failed, 0),
    excludedPartialDay: input.asOf < today ? today : null,
  };
  return { basis, days, today };
}

export class UsageForecastService {
  constructor(private readonly deps: {
    route: ForecastRoute | null;
    ledger: OperationLedger;
    usage: UsageRecorder;
    entries: () => Promise<UsageEntry[]>;
    now: () => Date;
  }) {}

  capability(): UsageForecastCapability {
    const r = this.deps.route;
    return r
      ? { available: true, provider: r.provider, requestedModel: r.backend.requestedModel, minCompleteDays: MIN_COMPLETE_DAYS,
        reason: "Runs only when you ask. Each forecast is one metered Clairic extraction request." }
      : { available: false, provider: null, requestedModel: null, minCompleteDays: MIN_COMPLETE_DAYS,
        reason: "No verified Clairic forecast route is configured. Set EPHYRA_FORECAST to notorganic or workers-ai." };
  }

  async forecast(principal: string, workspace: string, operationKey: string, input: UsageForecastInput, signal: AbortSignal): Promise<UsageForecast> {
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(operationKey))
      throw new ForecastError(400, "Supply a valid Idempotency-Key.", "invalid_operation_key");
    const route = this.deps.route;
    if (!route) throw new ForecastError(503, this.capability().reason, "unavailable");
    // Principal and workspace are part of the key: one person's key can never replay another scope's forecast.
    const key = `forecast:${sha256Hex(`${principal}\n${workspace}`).slice(0, 24)}:${operationKey}`;
    // Recovery binds to the original request, not a ledger snapshot that changes while the reply is in flight.
    const digest = sha256Hex(canonicalJson({ input, provider: route.provider, model: route.backend.requestedModel }));
    const previous = await this.deps.ledger.get(key);
    if (previous && previous.planDigest !== digest)
      throw new ForecastError(409, "This operation key belongs to a different forecast. Start a new forecast.", "operation_conflict");
    if (previous) return this.replay(key, previous);

    const { basis, days, today } = forecastBasis(await this.deps.entries(), input, this.deps.now());
    if (input.asOf >= today) throw new ForecastError(400, "Forecasts use complete days only. Choose a day before today (UTC).", "partial_day");
    if (basis.completeDays < MIN_COMPLETE_DAYS || basis.daysWithPricedSpend < MIN_PRICED_DAYS)
      return { status: "insufficient_history", basis, required: MIN_COMPLETE_DAYS };

    const history = days.map((d) => ({ day: d.day, priced_usd: +(d.spend / 1e6).toFixed(6), priced_entries: d.priced, unknown_cost_entries: d.unknown }));
    const maxDay = Math.max(...days.map((d) => d.spend));
    const request = {
      state: `<untrusted_usage_history>\n${JSON.stringify(history)}\n</untrusted_usage_history>\n` +
        "Daily priced agent spend in US dollars for complete UTC days. Entries with unknown cost are counted but have no price.",
      reference_date: input.asOf,
      fields: { [FIELD]: {
        type: "forecast" as const, unit: "USD", min: 0, max: Math.max(0.01, +((maxDay * 4) / 1e6).toFixed(6)),
        horizon: input.horizonDays, interval: "day" as const,
        instructions: `Forecast priced spend for each of the next ${input.horizonDays} UTC days after ${input.asOf}.`,
      } },
    };
    const claim = await this.deps.ledger.begin(key, digest);
    if (!claim.fresh) return this.replay(key, claim.record);
    const started = Date.now();
    const record = (outcome: "ok" | "failed" | "unavailable", engine: string, tokens: number | null, cost: number | null, note?: string) =>
      this.deps.usage.record({
        idempotencyKey: key, kind: "extract", persona: null, step: "usage.forecast", engine, trailId: null, short: null,
        tokens, costMicrousd: cost, wallMs: Date.now() - started, outcome, billedTo: route.billedTo, ...(note ? { note } : {}),
      });
    try {
      signal.throwIfAborted();
      const result = await route.backend.forecast(request, { idempotencyKey: key, signal });
      const tokens = result.usage?.input_tokens ?? null;
      const cost = result.usage?.cost_microusd ?? null;
      const answer = result.answers[FIELD];
      const points = answer ? forecastPoints(answer, input.horizonDays) : null;
      if (!points) {
        await record("failed", result.model, tokens, cost, "Forecast answer was incomplete or malformed.");
        const error = { status: 502 as const, message: "The forecast came back incomplete. Nothing was drawn.", code: "malformed" };
        await this.deps.ledger.complete(key, { error });
        throw new ForecastError(error.status, error.message, error.code);
      }
      const end = Date.parse(`${input.asOf}T00:00:00Z`);
      const value = UsageForecast.parse({
        status: "ok", basis, engine: result.model, requestedModel: route.backend.requestedModel, operationKey: key,
        days: points.map((p, i) => ({
          day: day(end + (i + 1) * DAY_MS),
          median: Math.max(0, Math.round(p.median * 1e6)),
          p10: p.p10 === null ? null : Math.max(0, Math.round(p.p10 * 1e6)),
          p90: p.p90 === null ? null : Math.max(0, Math.round(p.p90 * 1e6)),
        })),
        pNull: answer?.p_null ?? null,
        receipt: { tokens, costMicrousd: cost },
      });
      await record("ok", result.model, tokens, cost);
      await this.deps.ledger.complete(key, { value });
      return value;
    } catch (e) {
      if (e instanceof ForecastError) throw e;
      if (e instanceof ReconciliationRequired || (e instanceof Error && e.name === "AbortError")) {
        await this.deps.ledger.markAmbiguous(key, "forecast outcome unknown").catch(() => undefined);
        await record("unavailable", `unreported (${route.backend.requestedModel})`, null, null, "Outcome unknown; check provider usage.");
        throw new ReconciliationRequired(key, "The forecast request may have been billed. Check Usage before asking again.");
      }
      const error = e instanceof HttpError
        ? e.status === 429
          ? { status: 429 as const, message: "The forecast provider is rate limited.", code: "rate_limited", retryAfterSeconds: e.retryAfterSeconds }
          : e.status === 402
            ? { status: 503 as const, message: "The forecast account has no credit or allowance.", code: "payment_required" }
            : { status: 502 as const, message: `The forecast provider refused the request (HTTP ${e.status}).`, code: "provider_error" }
        : e instanceof UnexpectedIdentity
          ? { status: 502 as const, message: "The provider answered with an unexpected model identity.", code: "unexpected_identity" }
          : { status: 502 as const, message: "The forecast answer could not be read.", code: "malformed" };
      await record(error.code === "rate_limited" || error.code === "payment_required" ? "unavailable" : "failed",
        `unreported (${route.backend.requestedModel})`, null, null, error.message);
      // A rejected request did not run; the next attempt may use a new key. Rate limits stay unresolved for this key.
      await this.deps.ledger.complete(key, { error });
      throw new ForecastError(error.status, error.message, error.code, "retryAfterSeconds" in error ? error.retryAfterSeconds : undefined);
    }
  }

  private replay(key: string, record: { status: string; result?: unknown }): UsageForecast {
    if (record.status !== "done")
      throw new ReconciliationRequired(key, "A forecast with this key may still be billed. Check Usage before asking again.");
    const stored = record.result as {
      value?: UsageForecast;
      error?: { status: ForecastError["status"]; message: string; code: string; retryAfterSeconds?: number };
    };
    if (stored.error) throw new ForecastError(stored.error.status, stored.error.message, stored.error.code, stored.error.retryAfterSeconds);
    return UsageForecast.parse(stored.value);
  }
}
