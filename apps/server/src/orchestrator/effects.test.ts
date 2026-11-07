import { expect, test } from "bun:test";
import { ReconciliationRequired, type Trail } from "@ephyra/core";
import { EffectExecutor, MemoryOperationLedger } from "./effects.ts";
import type { EffectHandlers } from "../orchestrator.ts";

const trail = { id: "t" } as Trail;
const effect = { type: "reply_comment", key: "k", text: "hello" } as const;

test("effect replay runs only once and detects plan changes", async () => {
  let calls = 0;
  const handlers = { reply_comment: async () => { calls++; } } as unknown as EffectHandlers;
  const executor = new EffectExecutor(new MemoryOperationLedger(), handlers, { record: async () => {} });
  await executor.execute(effect, trail);
  await executor.execute(effect, trail);
  await expect(executor.execute({ ...effect, text: "changed" }, trail)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("ambiguous operations are recorded and never retried", async () => {
  let calls = 0;
  const recorded: string[] = [];
  const handlers = { reply_comment: async () => { calls++; throw new Error("timeout"); } } as unknown as EffectHandlers;
  const executor = new EffectExecutor(new MemoryOperationLedger(), handlers, { record: async (key) => { recorded.push(key); } });
  await expect(executor.execute(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
  await expect(executor.execute(effect, trail)).rejects.toBeInstanceOf(ReconciliationRequired);
  expect(recorded).toEqual(["k"]);
  expect(calls).toBe(1);
});
