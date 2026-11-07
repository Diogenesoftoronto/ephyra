import { expect, test } from "bun:test";
import { ReconciliationRequired } from "@ephyra/core";
import {
  NotOrganicDecide, NotOrganicExtract, TypeSafeDecide, SystemOneHttpDecide,
  WorkersAiClairicExtract, UnexpectedIdentity, UnsupportedQuestion, HttpError,
} from "../src/index.ts";

const question = { state: "example", questions: { yes: { type: "noul" as const, instructions: "?" } } };
const extract = { state: "hello", fields: { word: { type: "text" as const, instructions: "word" } } };
const decision = { model: "jev-1", answers: { yes: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 12 } };
const extraction = { model: "clairic", answers: { word: { type: "text", value: "hello", span: [0, 5], p_null: 0.1 } } };
const opts = { idempotencyKey: "op" };
const fake = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const keys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

test("Not Organic authenticates and binds DPoP proof to URL and token", async () => {
  const pair = await keys();
  const fetcher = fake(async (input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("DPoP token");
    expect(headers.get("idempotency-key")).toBe("op");
    const [head, payload, signature] = headers.get("dpop")!.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.htu).toBe(String(input));
    expect(claims.htm).toBe("POST");
    expect(claims.ath).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("token"))).toString("base64url"));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey,
      Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${head}.${payload}`))).toBe(true);
    return Response.json(String(input).endsWith("extraction") ? extraction : decision);
  });
  const config = { alias: "no", endpoint: "https://no.test", tokenProvider: { getAccessToken: async () => "token" },
    keys: pair, purpose: "decide.triage" as const, http: { fetch: fetcher } };
  expect((await new NotOrganicDecide(config).decide(question, opts)).model).toBe("jev-1");
  expect((await new NotOrganicExtract({ ...config, purpose: "extract" }).extract(extract, opts)).answers.word?.span).toEqual([0, 5]);
});

test("TypeSafe and self-hosted use documented System One wire format and enforce capabilities", async () => {
  const records: unknown[] = [];
  const config = { alias: "jev", endpoint: "https://api.test", credential: "secret", model: "jev-1",
    supports: ["noul"] as const, purpose: "decide.triage" as const, expectedIdentities: ["jev-1"],
    onUsage: (record: unknown) => { records.push(record); }, http: { fetch: fake(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      expect(JSON.parse(String(init?.body)).model).toBe("jev-1");
      return Response.json(decision);
    }) } };
  expect((await new TypeSafeDecide(config).decide(question, opts)).model).toBe("jev-1");
  expect(records).toMatchObject([{ alias: "jev", identity: "jev-1", tokens: 12, costMicrousd: null }]);
  const client = new SystemOneHttpDecide(config, "clef");
  await expect(client.decide({ state: "x", questions: { a: { type: "score", instructions: "?", criteria: ["x"] } } }, opts))
    .rejects.toBeInstanceOf(UnsupportedQuestion);
  await expect(new TypeSafeDecide({ ...config, expectedIdentities: ["other"] }).decide(question, opts))
    .rejects.toBeInstanceOf(UnexpectedIdentity);
});

test("Workers AI maps extraction envelope and preserves intervals", async () => {
  const client = new WorkersAiClairicExtract({ alias: "cf", accountId: "a", credential: "key",
    http: { fetch: fake(async (input) => {
      expect(String(input)).toContain("/accounts/a/ai/run/@cf/cloudflare/clairic");
      return Response.json({ success: true, result: { ...extraction, answers: {
        word: { ...extraction.answers.word, confidence: 0.9, p10: 1, p90: 3 },
      } } });
    }) } });
  expect((await client.extract(extract, opts)).answers.word).toMatchObject({ span: [0, 5], p_null: 0.1, p10: 1, p90: 3 });
});

test("client errors and ambiguous timeout propagate", async () => {
  const base = { alias: "jev", endpoint: "https://api.test", credential: "key", model: "m",
    supports: ["noul"] as const, purpose: "decide.triage" as const };
  await expect(new TypeSafeDecide({ ...base, http: { fetch: fake(async () => new Response(null, { status: 402 })) } })
    .decide(question, opts)).rejects.toBeInstanceOf(HttpError);
  const abortable = fake(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
  }));
  await expect(new TypeSafeDecide({ ...base, http: { fetch: abortable, timeoutMs: 1 } }).decide(question, opts))
    .rejects.toBeInstanceOf(ReconciliationRequired);
});

test("each transport rejects unexpected identities, maps errors, retries 429 and reconciles timeouts", async () => {
  const pair = await keys();
  for (const kind of ["notorganic-decide", "notorganic-extract", "typesafe", "selfhosted", "workers"] as const) {
    const isExtract = kind === "notorganic-extract" || kind === "workers";
    const invoke = async (fetcher: typeof fetch, expectedIdentities = ["other"]) => {
      const http = { fetch: fetcher, timeoutMs: 5, sleep: async () => {} };
      const common = { alias: "a", expectedIdentities, http };
      const no = { ...common, endpoint: "https://api.test", keys: pair,
        tokenProvider: { getAccessToken: async () => "token" }, purpose: "decide.triage" as const };
      const so = { ...common, endpoint: "https://api.test", credential: "key", model: "m",
        supports: ["noul"] as const, purpose: "decide.triage" as const };
      if (kind === "notorganic-decide") return new NotOrganicDecide(no).decide(question, opts);
      if (kind === "notorganic-extract") return new NotOrganicExtract({ ...no, purpose: "extract" }).extract(extract, opts);
      if (kind === "typesafe") return new TypeSafeDecide(so).decide(question, opts);
      if (kind === "selfhosted") return new SystemOneHttpDecide(so, "clef").decide(question, opts);
      return new WorkersAiClairicExtract({ ...common, accountId: "a", credential: "key" }).extract(extract, opts);
    };
    const result = isExtract ? extraction : decision;
    const body = kind === "workers" ? { success: true, result } : result;
    await expect(invoke(fake(async () => Response.json(body)))).rejects.toBeInstanceOf(UnexpectedIdentity);
    await expect(invoke(fake(async () => new Response(null, { status: 403 })))).rejects.toBeInstanceOf(HttpError);
    await expect(invoke(fake(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
    })))).rejects.toBeInstanceOf(ReconciliationRequired);
    let calls = 0;
    await invoke(fake(async (_input, init) => {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("op");
      return ++calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "0" } }) : Response.json(body);
    }), [result.model]);
    expect(calls).toBe(2);
  }
});
