import { describe, expect, test } from "bun:test";
import { ReconciliationRequired, type Effect, type Trail, type TrailEvent } from "@ephyra/core";
import { LocalOrchestrator, type EffectHandlers } from "./orchestrator.ts";

const trail = { id: "trail" } as Trail;
const event = { id: "event", trail: "trail" } as TrailEvent;
const effect: Effect = {type: "stop_agent", key: "operation", releaseLease: true};
const policy = { context: async () => ({now: "", blocking: {A:true,B:true,C:true}, landingModes: []}) };
describe("local orchestration", () => {
  test("deduplicates event and effect", async () => {
    let calls = 0;
    const handlers = {stop_agent: async () => { calls++; }} as unknown as EffectHandlers;
    const engine = new LocalOrchestrator((t) => ({ok:true, trail:t, effects:[effect]}), policy, handlers);
    engine.trails.set(trail.id, trail);
    await engine.apply(event); await engine.apply(event); await engine.execute(effect, trail);
    expect(calls).toBe(1); expect(engine.outbox.length).toBe(1);
  });
  test("does not retry an ambiguous failure", async () => {
    let calls = 0;
    const handlers = {stop_agent: async () => { calls++; throw new Error("timeout"); }} as unknown as EffectHandlers;
    const engine = new LocalOrchestrator((t) => ({ok:true, trail:t, effects:[]}), policy, handlers);
    await expect(engine.execute(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
    await expect(engine.execute(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
    expect(calls).toBe(1);
  });
});

test("effects wait for journal acknowledgement and conflicts recompute", async () => {
  let calls = 0;
  let transitions = 0;
  const handlers = { stop_agent: async () => { calls++; } } as unknown as EffectHandlers;
  const engine = new LocalOrchestrator((t) => {
    transitions++;
    return { ok: true, trail: t, effects: [effect] };
  }, policy, handlers);
  engine.trails.set(trail.id, trail);
  await engine.apply(event);
  expect(calls).toBe(0);
  let head = "one";
  let attempts = 0;
  const journal = {
    read: async () => ({ head, trail, events: [] }),
    append: async () => {
      attempts++;
      if (attempts === 1) { head = "two"; throw new Error("conflict"); }
      return "three";
    },
  } as unknown as import("@ephyra/core").Journal;
  await engine.publish(journal);
  expect(attempts).toBe(2);
  expect(transitions).toBe(3);
  expect(calls).toBe(1);
  await engine.publish(journal);
  expect(calls).toBe(1);
});
