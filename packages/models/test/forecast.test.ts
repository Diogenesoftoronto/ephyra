import { expect, test } from "bun:test";
import { forecastPoints, ReconciliationRequired } from "@ephyra/core";
import { HttpError, NotOrganicForecast, UnexpectedIdentity, WorkersAiClairicForecast } from "../src/index.ts";

// Answers copied from the Not Organic extraction contract v1 fixture (source: Cloudflare's Clairic model page).
const STEPS = { type: "forecast", value: [5, 5], steps: [
  { type: "estimate", value: 5, median: 5, p10: 2, p90: 8 }, { type: "estimate", value: 5, median: 5, p10: 2, p90: 8 }] };
const ARRAYS = { type: "forecast", value: [5, 6], median: [5, 6], p10: [2, 3], p90: [8, 9], mean: [5.1, 6.1] };
const request = { state: "<untrusted_usage>…</untrusted_usage>", reference_date: "2026-11-10",
  fields: { spend: { type: "forecast" as const, min: 0, max: 10, horizon: 2, interval: "day" as const } } };
const fake = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const keys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

test("Not Organic forecast posts a forecast field with the stable key and accepts per-step answers", async () => {
  let seen: { url: string; key: string | null; body: Record<string, unknown> } | null = null;
  const client = new NotOrganicForecast({ alias: "no", endpoint: "https://api.test", purpose: "extract", keys: await keys(),
    tokenProvider: { getAccessToken: async () => "token" },
    http: { fetch: fake(async (input, init) => {
      seen = { url: String(input), key: new Headers(init?.headers).get("idempotency-key"), body: JSON.parse(String(init?.body)) };
      return Response.json({ model: "clairic-2026-10", answers: { spend: STEPS }, usage: { input_tokens: 40, cost_microusd: 4 } });
    }) } });
  const out = await client.forecast(request, { idempotencyKey: "forecast:op-1" });
  expect(seen!.url).toBe("https://api.test/v1/extraction");
  expect(seen!.key).toBe("forecast:op-1");
  expect(seen!.body.model).toBe("extraction");
  expect(out.model).toBe("clairic-2026-10");
  expect(forecastPoints(out.answers.spend!, 2)).toEqual([{ median: 5, p10: 2, p90: 8 }, { median: 5, p10: 2, p90: 8 }]);
});

test("Workers AI forecast unwraps the envelope and accepts parallel arrays", async () => {
  const client = new WorkersAiClairicForecast({ alias: "cf", accountId: "acct", credential: "k",
    http: { fetch: fake(async (input) => {
      expect(String(input)).toContain("/accounts/acct/ai/run/@cf/cloudflare/clairic");
      return Response.json({ success: true, result: { model: "@cf/cloudflare/clairic", answers: { spend: ARRAYS } } });
    }) } });
  const out = await client.forecast(request, { idempotencyKey: "forecast:op-2" });
  expect(forecastPoints(out.answers.spend!, 2)?.[1]).toEqual({ median: 6, p10: 3, p90: 9 });
});

test("unexpected identity, rate limits and lost responses are explicit", async () => {
  const pinned = new WorkersAiClairicForecast({ alias: "cf", accountId: "a", credential: "k", expectedIdentities: ["@cf/cloudflare/clairic"],
    http: { fetch: fake(async () => Response.json({ success: true, result: { model: "other", answers: {} } })) } });
  await expect(pinned.forecast(request, { idempotencyKey: "k1" })).rejects.toBeInstanceOf(UnexpectedIdentity);
  const limited = new WorkersAiClairicForecast({ alias: "cf", accountId: "a", credential: "k",
    http: { retries: 0, fetch: fake(async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } })) } });
  const error = await limited.forecast(request, { idempotencyKey: "k2" }).catch((e) => e);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).retryAfterSeconds).toBe(12);
  const silent = new WorkersAiClairicForecast({ alias: "cf", accountId: "a", credential: "k",
    http: { retries: 0, fetch: fake(async () => new Response("{}", { status: 429 })) } });
  expect(((await silent.forecast(request, { idempotencyKey: "k3" }).catch((e) => e)) as HttpError).retryAfterSeconds).toBeUndefined();
  const lost = new WorkersAiClairicForecast({ alias: "cf", accountId: "a", credential: "k",
    http: { fetch: fake(async () => { throw new TypeError("network"); }) } });
  await expect(lost.forecast(request, { idempotencyKey: "k4" })).rejects.toBeInstanceOf(ReconciliationRequired);
});
