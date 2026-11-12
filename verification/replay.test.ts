import { expect, test } from "bun:test";
import { replayTrace } from "./replay.ts";
import completion from "./completion.itf.json";

test("generated Quint positive control completes in the actual reducer without human approval", () => {
  expect(replayTrace(completion)).toEqual({ modelSteps: 4, reducerEvents: 4, stutters: 0, completed: true, rejectedProofs: 0 });
});

test("a counterfeit model trace claiming stale proof was accepted diverges from implementation", () => {
  const wrong = structuredClone(completion);
  wrong.states[1]!.receiptHead = { "#bigint": "2" };
  expect(() => replayTrace(wrong)).toThrow("phase at step 1");
});

test("stale evidence can be rejected while keeping the quest able to continue", () => {
  const stale = structuredClone(completion);
  stale.states = stale.states.slice(0, 2);
  stale.states[1]!.receiptBase = { "#bigint": "1" };
  stale.states[1]!.phase = "proving";
  expect(replayTrace(stale)).toEqual({ modelSteps: 1, reducerEvents: 1, stutters: 0, completed: false, rejectedProofs: 1 });
});

test("empty or malformed trace is unavailable rather than a successful replay", () => {
  expect(() => replayTrace({ states: [] })).toThrow();
  const invalid = structuredClone(completion);
  invalid.states[0]!.revision = { "#bigint": "999999999999999999999" };
  expect(() => replayTrace(invalid)).toThrow("Invalid revision");
});

test("model stutters are not reported as implementation transitions", () => {
  const trace = structuredClone(completion);
  trace.states.push({ ...trace.states.at(-1)!, event: "idle" });
  expect(replayTrace(trace)).toEqual({ modelSteps: 5, reducerEvents: 4, stutters: 1, completed: true, rejectedProofs: 0 });
});
