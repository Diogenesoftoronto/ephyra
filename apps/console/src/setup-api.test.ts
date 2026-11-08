import { expect, test } from "bun:test";
import { SetupClient } from "./setup-api.ts";
import { ApiError, UnknownWriteOutcome } from "./api.ts";
import { SETUP_FIXTURE } from "./fake/setup.ts";

test("setup client binds cookie requests to principal and workspace and reconciles exact operation keys", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ ...SETUP_FIXTURE, operationKey: "setup:key" });
  }) as typeof fetch;
  const api = new SetupClient("https://console.example", "", "ws_one", "did:example:one", fetcher);
  await api.start({ mode: "autonomous" }, "setup:key");
  await api.current(undefined, "setup:key");
  expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("Authorization")).toBeNull();
  expect(headers.get("X-Ephyra-Workspace")).toBe("ws_one");
  expect(headers.get("X-Ephyra-Principal")).toBe("did:example:one");
  expect(headers.get("X-Ephyra-Account")).toBe("did:example:one");
  expect(headers.get("Idempotency-Key")).toBe("setup:key");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ mode: "autonomous" });
  expect(calls[1]!.init.method).toBe("GET");
  expect(calls[1]!.url.searchParams.get("operationKey")).toBe("setup:key");
});

test("setup client preserves ambiguous writes and rejects malformed successful results", async () => {
  for (const fetcher of [
    async () => { throw new Error("connection lost"); },
    async () => new Response("", { status: 503 }),
    async () => Response.json({ status: "ready" }),
    async () => Response.json(null),
    async () => Response.json({ ...SETUP_FIXTURE, operationKey: "another-tab" }),
  ]) {
    const api = new SetupClient("https://console.example", "token", "ws_one", "did:one", fetcher as typeof fetch);
    try { await api.start({ mode: "autonomous" }, "setup:pending"); throw new Error("write unexpectedly succeeded"); }
    catch (error) {
      expect(error).toBeInstanceOf(UnknownWriteOutcome);
      expect((error as UnknownWriteOutcome).operationKey).toBe("setup:pending");
    }
  }
});

test("setup conflict is a definite refusal and reading an absent run stays null", async () => {
  const refused = new SetupClient("https://console.example", "", "ws_one", "did:one",
    (async () => Response.json({ error: "Workspace changed" }, { status: 409 })) as typeof fetch);
  await expect(refused.start({ mode: "supervised" }, "setup:key")).rejects.toBeInstanceOf(ApiError);
  const empty = new SetupClient("https://console.example", "", "ws_one", "did:one", (async () => Response.json(null)) as typeof fetch);
  expect(await empty.current()).toBeNull();
});

const bootstrapInput = { setupId: "a".repeat(32), head: "b".repeat(40), requestId: "c".repeat(64), text: "A successful checkout sends a receipt." };
function answeredSetup(operationKey = "bootstrap-answer:one") {
  const at = "2026-11-08T12:00:00.000Z";
  return { ...structuredClone(SETUP_FIXTURE), id: bootstrapInput.setupId,
    repository: { ...SETUP_FIXTURE.repository, head: bootstrapInput.head },
    bootstrap: { schema: 1, setupId: bootstrapInput.setupId, head: bootstrapInput.head, assessedAt: at, nextAssessmentAt: at,
      sources: [], coverage: [], contextReports: [], requests: [{ id: bootstrapInput.requestId, kind: "context", status: "answered",
        question: "What should a successful checkout do?", options: [], createdAt: at, updatedAt: at,
        answer: { text: bootstrapInput.text, by: "did:example:owner", kind: "human", at, operationKey, digest: "d".repeat(64) } }] },
  };
}

test("bootstrap answer and reassessment calls keep the authenticated account and workspace binding", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new SetupClient("https://console.example", "", "ws_one", "did:example:owner", (async (url: URL, init: RequestInit) => {
    calls.push({ url, init }); return Response.json(answeredSetup());
  }) as typeof fetch);
  const saved = await api.respond(bootstrapInput, "bootstrap-answer:one");
  expect(saved.bootstrap?.requests[0]?.answer?.text).toBe(bootstrapInput.text);
  await api.reassess("bootstrap-check:one");
  expect(calls.map((call) => call.url.pathname)).toEqual(["/v1/setup/bootstrap/answer", "/v1/setup/bootstrap/reassess"]);
  for (const call of calls) {
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-Ephyra-Account")).toBe("did:example:owner");
    expect(headers.get("X-Ephyra-Workspace")).toBe("ws_one");
  }
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual(bootstrapInput);
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({});
});

test("an unrelated or malformed successful answer response keeps the exact write unconfirmed", async () => {
  for (const value of [
    null,
    answeredSetup("bootstrap-answer:someone-else"),
    { ...answeredSetup(), id: "f".repeat(32) },
    { ...answeredSetup(), repository: { ...SETUP_FIXTURE.repository, head: "f".repeat(40) } },
    { ...answeredSetup(), bootstrap: { ...answeredSetup().bootstrap, head: "f".repeat(40) } },
  ]) {
    const api = new SetupClient("https://console.example", "token", "ws_one", "did:example:owner",
      (async () => Response.json(value)) as typeof fetch);
    await expect(api.respond(bootstrapInput, "bootstrap-answer:one")).rejects.toBeInstanceOf(UnknownWriteOutcome);
  }
});

test("invalid bootstrap input is rejected before a request while response loss remains ambiguous", async () => {
  let calls = 0;
  const api = new SetupClient("https://console.example", "", "ws_one", "did:example:owner", (async () => {
    calls++; throw new Error("response lost");
  }) as typeof fetch);
  await expect(api.respond({ ...bootstrapInput, text: " " }, "bootstrap-answer:one")).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(api.respond(bootstrapInput, "bootstrap-answer:one")).rejects.toBeInstanceOf(UnknownWriteOutcome);
  expect(calls).toBe(1);
});

test("historical setup reads bind the exact ID and cannot reconcile a substituted snapshot", async () => {
  const calls: string[] = [];
  let substituted = false;
  const api = new SetupClient("https://console.example", "", "ws_one", "did:example:owner", (async (url: URL) => {
    calls.push(url.pathname); return Response.json({ ...answeredSetup(), ...(substituted ? { id: "f".repeat(32) } : {}) });
  }) as typeof fetch);
  expect((await api.record(bootstrapInput.setupId))?.id).toBe(bootstrapInput.setupId);
  expect(calls).toEqual([`/v1/setup/runs/${bootstrapInput.setupId}`]);
  substituted = true;
  await expect(api.record(bootstrapInput.setupId)).rejects.toThrow("did not match");
  await expect(api.record("../current")).rejects.toThrow("Invalid setup record");
  expect(calls).toHaveLength(2);
});
