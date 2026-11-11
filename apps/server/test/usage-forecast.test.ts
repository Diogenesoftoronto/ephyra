import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { MemoryOperationLedger } from "@ephyra/forge";
import { ReconciliationRequired, type ExtractionForecastRequest, type ForecastBackend, type UsageEntry } from "@ephyra/core";
import { HttpError } from "@ephyra/models";
import { ForecastError, forecastBasis, UsageForecastService } from "../src/usage-forecast.ts";
import { MemoryUsageStore, UsageRecorder } from "../src/usage.ts";
import { usageForecastRoutes } from "../src/http/usage-forecast.ts";
import { Hono } from "hono";

const NOW = new Date("2026-11-11T15:00:00Z");
const entry = (day: string, cost: number | null, i = 0, outcome: UsageEntry["outcome"] = "ok"): UsageEntry => ({
  id: `${day}-${i}`, idempotencyKey: `${day}-${i}`, at: `${day}T10:00:00.000Z`, kind: "agent_step", persona: "lappet", step: "patch",
  engine: "fixture/engine", trailId: null, short: null, tokens: 10, costMicrousd: cost, wallMs: 1, outcome, billedTo: "local",
});
const history = (days: number, cost: number | null = 500_000) =>
  Array.from({ length: days }, (_, i) => entry(new Date(Date.parse("2026-11-10T00:00:00Z") - i * 86_400_000).toISOString().slice(0, 10), cost, i));

function backend(answer: unknown, calls: ExtractionForecastRequest[] = []): ForecastBackend {
  return { kind: "notorganic", alias: "fixture", requestedModel: "extraction", forecast: async (req) => {
    calls.push(req);
    if (answer instanceof Error) throw answer;
    return { model: "clairic-2026-10", answers: { daily_spend_usd: answer as never }, usage: { input_tokens: 30, cost_microusd: 3 } };
  } };
}
function fixture(entries: UsageEntry[], answer: unknown, calls: ExtractionForecastRequest[] = []) {
  const store = new MemoryUsageStore();
  const service = new UsageForecastService({
    route: { backend: backend(answer, calls), provider: "notorganic", billedTo: "notorganic" },
    ledger: new MemoryOperationLedger(), usage: new UsageRecorder(store), entries: async () => entries, now: () => NOW,
  });
  return { service, store };
}
const input = { asOf: "2026-11-10", historyDays: 14, horizonDays: 2 };
const ok = { type: "forecast", value: [0.5, 0.6], median: [0.5, 0.6], p10: [0.2, 0.3], p90: [0.8, 0.9] };
const signal = () => new AbortController().signal;

describe("usage forecast", () => {
  test("the basis covers complete UTC days only and excludes today's partial day", () => {
    fc.assert(fc.property(fc.integer({ min: 7, max: 90 }), fc.array(fc.integer({ min: 0, max: 120 }), { maxLength: 50 }), (days, offsets) => {
      const entries = offsets.map((o, i) => entry(new Date(Date.parse("2026-11-11T00:00:00Z") - o * 86_400_000).toISOString().slice(0, 10), i % 3 ? 100 : null, i));
      const { basis, days: rows } = forecastBasis(entries, { asOf: "2026-11-10", historyDays: days, horizonDays: 1 }, NOW);
      expect(rows).toHaveLength(days);
      expect(basis.to).toBe("2026-11-10");
      expect(basis.excludedPartialDay).toBe("2026-11-11");
      expect(rows.every((r) => r.day < "2026-11-11")).toBe(true);
      expect(basis.pricedEntries + basis.unknownCostEntries).toBeLessThanOrEqual(entries.length);
    }));
  });
  test("insufficient history never calls the provider", async () => {
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(history(2), ok, calls);
    const out = await f.service.forecast("did:a", "w1", "forecast-op-0001", input, signal());
    expect(out.status).toBe("insufficient_history");
    expect(calls).toHaveLength(0);
    expect(await f.store.list()).toHaveLength(0);
  });
  test("a forecast is metered once, wraps history as untrusted data and replays for the same key", async () => {
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(history(14), ok, calls);
    const first = await f.service.forecast("did:a", "w1", "forecast-op-0002", input, signal());
    if (first.status !== "ok") throw new Error("expected ok");
    expect(first.engine).toBe("clairic-2026-10");
    expect(first.days.map((d) => d.day)).toEqual(["2026-11-11", "2026-11-12"]);
    expect(first.days[0]).toEqual({ day: "2026-11-11", median: 500_000, p10: 200_000, p90: 800_000 });
    expect(calls[0]!.state).toContain("<untrusted_usage_history>");
    expect(calls[0]!.fields.daily_spend_usd).toMatchObject({ type: "forecast", horizon: 2, interval: "day" });
    expect(await f.service.forecast("did:a", "w1", "forecast-op-0002", input, signal())).toEqual(first);
    expect(calls).toHaveLength(1);
    const rows = await f.store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: "usage.forecast", engine: "clairic-2026-10", costMicrousd: 3, outcome: "ok" });
  });
  test("another principal or workspace cannot replay the same key", async () => {
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(history(14), ok, calls);
    await f.service.forecast("did:a", "w1", "forecast-op-0003", input, signal());
    await f.service.forecast("did:b", "w1", "forecast-op-0003", input, signal());
    await f.service.forecast("did:a", "w2", "forecast-op-0003", input, signal());
    expect(calls).toHaveLength(3);
  });
  test("a saved forecast recovers its original snapshot after history changes or is unavailable", async () => {
    const entries = history(14);
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(entries, ok, calls);
    const first = await f.service.forecast("did:a", "w1", "forecast-recover-01", input, signal());
    entries.push(entry("2026-11-10", 2_000_000, 100));
    expect(await f.service.forecast("did:a", "w1", "forecast-recover-01", input, signal())).toEqual(first);
    entries.splice(0);
    expect(await f.service.forecast("did:a", "w1", "forecast-recover-01", input, signal())).toEqual(first);
    await expect(f.service.forecast("did:a", "w1", "forecast-recover-01", { ...input, horizonDays: 7 }, signal()))
      .rejects.toMatchObject({ code: "operation_conflict" });
    expect(calls).toHaveLength(1);
  });
  test("an ambiguous forecast remains ambiguous when new usage arrives", async () => {
    const entries = history(14);
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(entries, new ReconciliationRequired("k", "lost"), calls);
    await expect(f.service.forecast("did:a", "w1", "forecast-recover-02", input, signal())).rejects.toBeInstanceOf(ReconciliationRequired);
    entries.push(entry("2026-11-10", 2_000_000, 101));
    await expect(f.service.forecast("did:a", "w1", "forecast-recover-02", input, signal())).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(calls).toHaveLength(1);
  });
  test("malformed answers are errors, not drawn forecasts", async () => {
    const f = fixture(history(14), { type: "forecast", value: [0.5, 0.6], median: [0.5, 0.6], p10: [0.2], p90: [0.8, 0.9] });
    await expect(f.service.forecast("did:a", "w1", "forecast-op-0004", input, signal())).rejects.toMatchObject({ code: "malformed" });
  });
  test("a lost response stays unresolved; the same key never calls again", async () => {
    const calls: ExtractionForecastRequest[] = [];
    const f = fixture(history(14), new ReconciliationRequired("k", "lost"), calls);
    await expect(f.service.forecast("did:a", "w1", "forecast-op-0005", input, signal())).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(f.service.forecast("did:a", "w1", "forecast-op-0005", input, signal())).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(calls).toHaveLength(1);
    expect((await f.store.list())[0]).toMatchObject({ outcome: "unavailable", costMicrousd: null });
  });
  test("rate limits pass through the provider's Retry-After only", async () => {
    const f = fixture(history(14), new HttpError(429, 20));
    const e = await f.service.forecast("did:a", "w1", "forecast-op-0006", input, signal()).catch((x) => x);
    expect(e).toBeInstanceOf(ForecastError);
    expect(e).toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 20 });
    const g = fixture(history(14), new HttpError(429));
    expect(await g.service.forecast("did:a", "w1", "forecast-op-0007", input, signal()).catch((x) => x.retryAfterSeconds)).toBeUndefined();
  });
  test("today is refused as a history end", async () => {
    const f = fixture(history(14), ok);
    await expect(f.service.forecast("did:a", "w1", "forecast-op-0008", { ...input, asOf: "2026-11-11" }, signal())).rejects.toMatchObject({ code: "partial_day" });
  });
  test("an unconfigured route is unavailable over HTTP and GET never spends", async () => {
    const service = new UsageForecastService({ route: null, ledger: new MemoryOperationLedger(), usage: new UsageRecorder(new MemoryUsageStore()), entries: async () => [], now: () => NOW });
    const app = new Hono().use("*", async (c, next) => { (c as never as { set: (k: string, v: string) => void }).set("principal", "did:a"); await next(); })
      .route("/", usageForecastRoutes(service) as never);
    const cap = await (await app.request("/v1/usage/forecast")).json();
    expect(cap).toMatchObject({ available: false, provider: null, requestedModel: null });
    const res = await app.request("/v1/usage/forecast", { method: "POST", headers: { "Idempotency-Key": "forecast-op-0009", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
  });
});
