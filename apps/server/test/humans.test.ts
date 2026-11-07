import { expect, test } from "bun:test";
import fc from "fast-check";
import { ReconciliationRequired, sha256Hex, Unverified } from "@ephyra/core";
import { MemoryOperationLedger } from "@ephyra/forge";
import { AmpersandDraftModel, AMPERSAND_MODEL, TUTOR_MODEL } from "../src/humans.ts";
import { readConfig } from "../src/config.ts";

const request = { system: "Clarify intent; no tools.", messages: [{ role: "user" as const, content: "Keep payment approval manual." }], idempotencyKey: "draft:one:human" };
const events = (model = AMPERSAND_MODEL) => [
  { type: "agent.session.created", session: { id: "sess_test", agent: { model } } },
  { type: "agent.session.turn.output_text.delta", session_id: "sess_test", turn_id: "turn_one", delta: "provisional" },
  { type: "agent.session.turn.output_text.done", session_id: "sess_test", turn_id: "turn_one", output_index: 0, content_index: 0, text: "Which payment paths need your approval?" },
  { type: "agent.session.turn.completed", session_id: "sess_test", turn_id: "turn_one", turn: { id: "turn_one", status: "completed" }, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
];
function stream(value: unknown[], split = 43) {
  const bytes = new TextEncoder().encode(value.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split)); c.close(); } }),
    { headers: { "content-type": "text/event-stream" } });
}
test("Humans& uses its session protocol, exact identity and reported tokens; never sends a create idempotency header", async () => {
  const seen: Request[] = [], ledger = new MemoryOperationLedger();
  const model = new AmpersandDraftModel("fixture-secret", ledger, AMPERSAND_MODEL, async (url, init) => { seen.push(new Request(url, init)); return stream(events()); });
  const result = await model.complete(request);
  expect(result).toEqual({ text: "Which payment paths need your approval?", engine: AMPERSAND_MODEL, tokens: 30, costMicrousd: null });
  expect(await model.complete(request)).toEqual(result); expect(seen).toHaveLength(1);
  expect(seen[0]!.headers.get("Idempotency-Key")).toBeNull();
  expect(seen[0]!.headers.get("OpenAI-Beta")).toBe("agents=v1");
  expect(await seen[0]!.json()).toMatchObject({ environment: { type: "none" }, agent: { model: AMPERSAND_MODEL, reasoning: { effort: "low" }, ampersand: { allow_silent_completion: false } }, stream: true });
  expect((await ledger.get(`humans:${sha256Hex(request.idempotencyKey)}:session`))?.result).toEqual({ sessionId: "sess_test", requestedModel: AMPERSAND_MODEL });
});
test("SSE framing is independent of byte chunk boundaries", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 150 }), async split => {
    const m = new AmpersandDraftModel("fixture", new MemoryOperationLedger(), AMPERSAND_MODEL, async () => stream(events(), split));
    expect((await m.complete(request)).tokens).toBe(30);
  }), { numRuns: 35 });
});
test("a truncated stream saves the session, attempts cancellation, and never recreates after restart", async () => {
  const ledger = new MemoryOperationLedger(), seen: Request[] = [];
  const fetcher = async (url: string, init?: RequestInit) => { seen.push(new Request(url, init)); return url.endsWith("/events") ? new Response(null, { status: 202 }) : stream(events().slice(0, 2)); };
  await expect(new AmpersandDraftModel("fixture", ledger, AMPERSAND_MODEL, fetcher).complete(request)).rejects.toBeInstanceOf(ReconciliationRequired);
  await expect(new AmpersandDraftModel("fixture", ledger, AMPERSAND_MODEL, fetcher).complete(request)).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(seen).toHaveLength(2);
  expect(seen[1]!.url).toEndWith("/sess_test/events");
  expect(await seen[1]!.json()).toEqual({ events: [{ type: "agent.session.input.cancel" }] });
  expect((await ledger.get(`humans:${sha256Hex(request.idempotencyKey)}`))?.status).toBe("reconciliation_required");
});
test("wrong model identity, missing text, unknown acceptance and cross-turn text never become answers", async () => {
  for (const values of [events(TUTOR_MODEL), events().filter(e => !e.type.endsWith("output_text.done")), events().map(e => e.type.endsWith("output_text.done") ? { ...e, turn_id: "another_turn" } : e)]) {
    const m = new AmpersandDraftModel("fixture", new MemoryOperationLedger(), AMPERSAND_MODEL, async url => url.endsWith("/events") ? new Response(null, { status: 202 }) : stream(values));
    await expect(m.complete(request)).rejects.toBeInstanceOf(ReconciliationRequired);
  }
  const m = new AmpersandDraftModel("fixture", new MemoryOperationLedger(), AMPERSAND_MODEL, async () => new Response(null, { status: 503 }));
  await expect(m.complete(request)).rejects.toBeInstanceOf(ReconciliationRequired);
});
test("known rejection and already-aborted requests never retry", async () => {
  let calls = 0;
  const m = new AmpersandDraftModel("fixture", new MemoryOperationLedger(), AMPERSAND_MODEL, async () => { calls++; return new Response(null, { status: 401 }); });
  await expect(m.complete({ ...request, signal: AbortSignal.abort() })).rejects.toThrow(); expect(calls).toBe(0);
  await expect(m.complete(request)).rejects.toBeInstanceOf(Unverified);
  await expect(m.complete(request)).rejects.toBeInstanceOf(Unverified); expect(calls).toBe(1);
});
test("configuration keeps roles explicit and hosted Tutor requires an account", () => {
  const base = { EPHYRA_API_TOKEN: "fixture-api-token" };
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "ampersand" })).toThrow("EPHYRA_HUMANS_API_KEY");
  expect(() => readConfig({ ...base, EPHYRA_TUTOR: "notorganic" })).toThrow("sign-in");
  expect(() => readConfig({ ...base, EPHYRA_DRAFT: "ampersand", EPHYRA_DRAFT_MODEL: TUTOR_MODEL, EPHYRA_HUMANS_API_KEY: "fixture" })).toThrow("EPHYRA_TUTOR");
  expect(readConfig({ ...base, EPHYRA_DRAFT: "ampersand", EPHYRA_TUTOR: "ampersand", EPHYRA_HUMANS_API_KEY: "fixture" }).EPHYRA_TUTOR).toBe("ampersand");
});
