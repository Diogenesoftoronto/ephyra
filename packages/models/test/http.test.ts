import { expect, test } from "bun:test";
import { ReconciliationRequired } from "@ephyra/core";
import { HttpError, postJson } from "../src/http.ts";

test("retries an explicit rate limit with Retry-After and preserves the operation key", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("op-1");
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
      : Response.json({ ok: true });
  }) as unknown as typeof fetch;
  expect(await postJson("https://example.test", {}, {}, {
    key: "op-1", fetch: fake, sleep: async (ms) => { delays.push(ms); },
  })).toEqual({ ok: true });
  expect(delays).toEqual([1000]);
});

test("network failures require reconciliation and HTTP errors retain their status", async () => {
  const failed = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await expect(postJson("https://example.test", {}, {}, { key: "op-2", fetch: failed }))
    .rejects.toBeInstanceOf(ReconciliationRequired);
  const unauthorized = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
  await expect(postJson("https://example.test", {}, {}, { key: "op-3", fetch: unauthorized }))
    .rejects.toBeInstanceOf(HttpError);
});
